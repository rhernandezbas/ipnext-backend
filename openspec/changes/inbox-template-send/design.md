# Design — inbox-template-send

## 0. Mapa del flujo (end-to-end)

```
FE Composer (ventana expirada, rama Composer.tsx:240-244)
  └─ CTA "Enviar template" → TemplateSendPanel (modal)
       ├─ GET /api/messaging/send-templates  ──────────────► ListTemplates (use case EXISTENTE)
       │    (perms.send)                                        └─ TemplateMessagingPort.listTemplates
       └─ POST /api/messaging/conversations/:id/send-template
            {templateRef, variables}          ─────────────► SendTemplateMessage (use case NUEVO)
            (perms.send)                                        1. ConversationRepository.findById
                                                                2. teléfono E164 (o 422)
                                                                3. template aprobado (o 422)
                                                                4. variables completas (o 422)
                                                                5. TemplateMessagingPort.sendTemplate
                                                                6. ChatMessageRepository.upsertTemplateMessage
                                                                   (origin 'agent_template', key providerMessageId)
                                                                7. ConversationRepository.bumpLastMessage
                                                                8. return ChatMessageDto (201)
```

El mensaje aterriza en el hilo por el mismo mecanismo que el bulk: `listByConversation` es
origin-agnóstico (`ChatMessageRepository.ts:58`) y `toChatMessageDto` no filtra por origin
(`application/dto/messaging.ts:267-280`) — cero cambios en `ListMessages`/`GetConversation`.

---

## D1 — Twilio Content directo, NUNCA Chatwoot

`ChatwootGateway.sendMessage` manda texto plano por el canal Chatwoot→Twilio; fuera de la ventana
de 24h Twilio rechaza texto plano — un template solo es enviable con `ContentSid` por la Messages
API (`TwilioContentGateway.sendTemplate`, `TwilioContentGateway.ts:124-156`). Además `SendMessage`
corta con 422 en el guard 2 (`SendMessage.ts:122-124`) sin llegar a Chatwoot. Por eso el envío va
por `TemplateMessagingPort.sendTemplate(to, contentSid, variables)`
(`domain/ports/TemplateMessagingPort.ts:103`) — el MISMO port/adapter/fake que el bulk (send-path
LOCKED D2 de messaging-bulk). El use case NUNCA ve JSON crudo de Twilio.

## D2 — Regla de plataforma: el template NO abre la ventana (LOCKED, verificada por el usuario)

La ventana de 24h la abre SOLO el inbound del cliente. Consecuencias de diseño:

- `SendTemplateMessage` MUST NOT tocar `canReply` ni `status` de la conversación. El nuevo método
  `bumpLastMessage` (D5) solo escribe `lastMessageAt`/`lastMessagePreview` — misma disciplina de
  write-paths separados que `updateLocalFields` (`ConversationRepository.ts:79-89`) y
  `upsertBulkByPhone` (`:109-122`): ningún camino nuevo puede pisar el cache de Chatwoot.
- El endpoint NO valida `canReply` (ni a favor ni en contra): un template es enviable SIEMPRE
  (dentro o fuera de ventana) — igual que Chatwoot. El caso de uso primario es fuera de ventana,
  pero no se prohíbe dentro.
- FE: tras enviar, el composer SIGUE bloqueado (aviso de ventana intacto). El panel cierra con
  announcement "Template enviado" — sin fingir que la ventana se abrió. El mensaje aparece en el
  hilo (append-on-success) como única confirmación visual.

## D3 — Proyección propia por `conversationId`, NO reusar `CampaignInboxProjector`

Evaluado reusar `upsertBulkByPhone`/el projector con un origin nuevo — RECHAZADO:

1. La conversación acá YA EXISTE y es la que el agente tiene abierta. `upsertBulkByPhone` resuelve
   "la conversación MÁS RECIENTE con ese `contactPhoneE164`" (`ConversationRepository.ts:113-115`)
   — con duplicados del mismo E164 podría aterrizar el mensaje en OTRA conversación distinta de la
   que el agente está mirando. Inaceptable para un envío one-off desde el hilo.
2. La idempotencia del projector keyea por `campaignRecipientId` (`CampaignInboxProjector.ts:18`,
   `schema.prisma:2875`) — acá no hay recipient.
3. El projector es best-effort/aislado (contrato de `SendCampaign`); acá la proyección es parte de
   la respuesta síncrona (el FE necesita el `ChatMessageDto`).

En su lugar: dos métodos de port NUEVOS, quirúrgicos (specs TS-6):
- `ChatMessageRepository.upsertTemplateMessage(input)` — crea/upserta el `ChatMessage`
  `{origin:'agent_template', direction:'outbound', chatwootMessageId:null, campaignRecipientId:null,
  providerMessageId, content: renderedBody, senderName, chatwootCreatedAt: sentAt}`.
- `ConversationRepository.bumpLastMessage(conversationId, {lastMessageAt, lastMessagePreview})`.

`renderedBody` se computa con `renderTemplateBody(template.body, variables)` — REUSO de la función
exportada (`SendCampaign.ts:311-317`, pura/total/nunca throws; body vacío → `''`, degradación
segura idéntica al bulk).

## D4 — Origin `'agent_template'` (no `'template'`)

`ChatMessage.origin` es String plano (`schema.prisma:2871`, `'chatwoot'` default | `'bulk'`) —
sin migración de enum. Se elige `'agent_template'` porque `'template'` colisiona con el
vocabulario `message_type: 'template'` de Chatwoot que el webhook FILTRA deliberadamente
(comentario en `schema.prisma:2877-2879`) — un origin homónimo invitaría a confundir dos conceptos
distintos (mensaje de sistema de Chatwoot vs template enviado por un agente).

## D5 — Idempotencia y fallas post-accept

- **Clave de idempotencia del mirror**: `providerMessageId` (SM sid de Twilio), columna nueva
  `String? @unique` en `ChatMessage` (migración aditiva; PG trata NULLs como distintos — las filas
  chatwoot/bulk existentes no chocan). Re-proyectar el MISMO envío jamás duplica la fila. Además
  queda la traza de auditoría que el bulk guarda en `CampaignRecipient.providerId` y que el one-off
  perdería por completo sin esta columna.
- **El POST en sí NO es idempotente**: un retry del agente genera un SM sid nuevo = mensaje real
  nuevo. Mismo contrato que el path Chatwoot (`SendMessage`) — documentado, mitigado en FE (confirm
  deshabilitado en vuelo, D11).
- **Falla del mirror DESPUÉS de que Twilio aceptó**: propaga (500) — precedente `SendMessage`
  (`SendMessage.ts:152-162`, el upsert post-OK no está aislado). NO se adopta el aislamiento
  best-effort de `SendCampaign` porque acá la respuesta ES el DTO del mensaje: no hay nada útil que
  devolver si el mirror no se escribió. Riesgo aceptado y documentado (el agente ve error, el
  mensaje salió; el reintento re-envía — igual que hoy con Chatwoot).

## D6 — Sin retry/backoff en el envío one-off

`SendCampaign` envuelve `sendTemplate` en `sendWithRetry` (backoff 429-aware) porque es un batch
worker. Acá el request es interactivo: un 429/5xx de Twilio sale INMEDIATO como
`TEMPLATE_PROVIDER_UNAVAILABLE` → 503 (`errorHandler.ts:167`) y el agente decide reintentar.
Errores del port ya tipados y mapeados (cero statusMap nuevo salvo `CONVERSATION_PHONE_MISSING`):
`TemplateSendRejectedError` → 422, `TemplateProviderConfigError` → 503
(`domain/errors/messaging-bulk.ts:38-63`, `errorHandler.ts:171-172`).

## D7 — Catálogo del picker: ruta NUEVA `GET /api/messaging/send-templates` bajo `perms.send`

Alternativas evaluadas:

| Opción | Tradeoff |
|---|---|
| (a) FE reusa `GET /api/messaging/bulk/templates` | Cero BE nuevo, PERO gateado por `messaging.templates` (`app.ts:2646-2647`) — un agente de inbox con solo `messaging.send` come 403; acopla la capacidad del inbox al rol de bulk |
| (b) **ELEGIDA**: ruta nueva en `createMessagingRouter` (path `/send-templates`), guard `perms.send`, reusando el use case `ListTemplates` tal cual | +1 ruta trivial; coherencia de capacidad: el permiso que habilita enviar el template habilita ver el catálogo necesario para hacerlo (mismo criterio que `/assignable-users` bajo `perms.read`, `messaging.routes.ts:508-523`) |

Path `/send-templates` NO colisiona: el router de `/api/messaging` se monta ANTES que
`/api/messaging/templates` (CRUD) y `/api/messaging/bulk` (`app.ts:2560/2627/2665`) — un path
`/templates` en el router del inbox SHADOWEARÍA al CRUD (Express matchea por orden de registro);
`/send-templates` es único. Tampoco se anida bajo `/conversations/...` para no depender del orden
de registro contra `/conversations/:id`. Respuesta `{data: TemplateSummaryDto[]}` — mismo envelope
y DTO que el bulk (`messagingBulk.routes.ts:109-121`); el FE filtra `sendable`.

Wiring en `app.ts`: el bloque del messaging router instancia su PROPIO `TwilioContentGateway`
(mismo config `config.twilio.*`) — precedente deliberado del bloque templates-CRUD
(`app.ts:2652-2663`, "self-contained para no interleave en merges"). Ese gateway alimenta
`ListTemplates` y `SendTemplateMessage`.

## D8 — Variables como VALORES planos (`Record<string,string>`), no `CampaignVariableSpec`

El bulk mapea variables a FUENTES (`name`/`balanceDue`/`literal`) porque el valor varía
por-destinatario (`SendCampaign.resolveCampaignVariables:319-338`). El one-off tiene UN
destinatario a la vista del agente: el agente escribe/ve el valor final. Reusar el spec por fuentes
obligaría al BE a resolver el cliente de la conversación (matching fuzzy `matched/ambiguous/unknown`
del client-context) — complejidad sin valor. El wire lleva los valores resueltos:
`{templateRef: 'HX…', variables: {'1':'Juan','2':'$5.000'}}` — exactamente el shape que
`sendTemplate` ya espera (`TemplateMessagingPort.ts:94-103`, "mapa índice/nombre→valor ya
resuelto").

Validación (misma semántica que `CreateCampaign` CAMP-2/CAMP-3, `CreateCampaign.ts:47-63`):
- `templateRef` inexistente en el proveedor == no aprobado → `TemplateNotApprovedError` (422).
- TODAS las variables declaradas (`Object.keys(template.variables)`) deben estar presentes como
  keys → `MissingTemplateVariablesError(missing)` (422, lleva `missing[]` para que el FE resalte).
  Extra no declaradas NO bloquean (mismo criterio CAMP-3).

## D9 — Orden de guards del use case (PINNED, molde `SendMessage`)

`SendTemplateMessage.execute(conversationId, templateRef, variables, senderName)`:

1. `conversationRepo.findById` → `ConversationNotFoundError` (404).
2. Teléfono: `conversation.contactPhoneE164 ?? toWhatsAppE164(conversation.contactPhone)`
   (`application/use-cases/messaging/toWhatsAppE164.ts:30`; el E164 del mirror es backfill
   best-effort — el fallback cubre filas pre-backfill). Ambos null → NUEVO
   `ConversationPhoneMissingError` → 422 (code `CONVERSATION_PHONE_MISSING`, en
   `domain/errors/messaging.ts`, statusMap + doc del archivo actualizados).
3. `templatePort.listTemplates()` → find por `contentSid` → aprobado o 422 (D8).
4. Variables completas o 422 (D8).
5. `templatePort.sendTemplate(phoneE164, templateRef, variables)` — errores propagan tipados (D6).
   Hasta acá NADA persistido (mismo contrato "no side effects before send" que SendMessage).
6. `sentAt = new Date().toISOString()`; `renderedBody = renderTemplateBody(template.body, variables)`;
   `upsertTemplateMessage(...)` con `providerMessageId = result.providerId`.
7. `bumpLastMessage(conversationId, {lastMessageAt: sentAt, lastMessagePreview: renderedBody})` —
   nunca toca canReply/status (D2). Preview con body vacío: se escribe `''` igual que el bulk
   (degradación conocida).
8. `return toChatMessageDto(record, [])`.

`senderName` = `req.user?.username ?? null` (shape real de `req.user`: `{id, username, email}`,
`domain/entities/auth.ts:1-8`) — el hilo muestra QUIÉN mandó el template (el bulk deja null; acá
hay un agente concreto).

## D10 — Ruta y parsing

`POST /conversations/:id/send-template` en `createMessagingRouter` (factory gana 2 args:
`sendTemplateMessage`, `listSendableTemplates` — patrón de todos los args previos). JSON-only (sin
multer ni rate-limiter: el `conditionalSendRateLimiter` es para el DoS de media multipart,
`messaging.routes.ts:150-158`). Validación inline del body (molde del check de `content` en
`/messages`, `messaging.routes.ts:427-430`):
- `templateRef` ausente/no-string/vacío → 400 `VALIDATION_ERROR`.
- `variables` presente pero no-objeto-plano-de-strings → 400 `VALIDATION_ERROR`. Ausente → `{}`.
- Todo lo demás → try/catch → `next(err)` → statusMap (lección 504/ROB-1).

## D11 — FE: datos y estado

- **API** (`whatsapp.api.ts`): `listSendableTemplates()` → GET `/messaging/send-templates`, unwrap
  `{data}` (mismo criterio documentado del envelope asimétrico, `whatsapp.api.ts:20-24`); tipo
  REUSADO `TemplateSummaryDto` de `types/messagingBulk.ts:16-32` (import cross-feature, cero
  duplicación). `sendWhatsappTemplate(id, {templateRef, variables})` → POST, respuesta flat
  `WhatsappMessage` (201).
- **Hooks** (`useWhatsapp.ts`):
  - `useSendableTemplates(enabled)` — key `['whatsapp','sendTemplates']`, `staleTime: 60_000`,
    `enabled` = panel abierto (molde `useTemplates(enabled)`, `useBulkMessaging.ts:41-48`).
  - `useSendWhatsappTemplate(id)` — mutation; TODAS las keys derivadas de `vars.convId` capturado
    al disparar, NUNCA del closure `id` (memoria `inbox-key-por-conversacion`; mismo patrón bug
    CRÍTICO #1 de `useSendWhatsappMessage`, `useWhatsapp.ts:164-174`). `onSuccess`: `await
    cancelQueries(messagesKey)` → append dedup por `message.id` → `invalidateQueries(conversations
    root)` (clon EXACTO de `useWhatsapp.ts:203-213`). Expone `{sendTemplate, isPending (scoped por
    convId, molde `useWhatsapp.ts:387`), isError, error, reset}`.
  - **Sin burbuja optimista/pendingSends**: el flujo es modal-bloqueante (confirm → spinner en el
    botón del modal → cierre on-success). El slice `pendingSends` existe para el composer no
    bloqueante con uploads largos; un template es un POST JSON corto. El "aparece al toque" lo da
    el append-on-success (sin esperar el poll de 5s).
- **Composer** (`Composer.tsx`): la rama del aviso estático (`:240-244`) gana el CTA
  "Enviar template" (button secundario) + estado local `templatePanelOpen`. El CTA vive DENTRO del
  `<Can permission="messaging.send">` existente (`:206`) — permiso idéntico al send, cero gate
  nuevo. El CTA NO aparece en las otras 3 ramas (verificando/error de verificación/ventana
  abierta) ni en modo nota.
- **`TemplateSendPanel`** (componente nuevo en `WhatsappInboxPage/components/`): modal por portal,
  molde a11y de `PreviewModal` del bulk (`role="dialog"`, `aria-modal`, `aria-labelledby`, focus
  al cerrar-btn on-open, focus-return al CTA on-close, Esc cierra, backdrop click cierza —
  `PreviewModal.tsx:198-209`). `key={conversationId}` en el mount desde Composer (memoria: estado
  local del inbox SIEMPRE keyed por conversación). Contenido:
  1. Select PROPIO (`molecules/Select`) con SOLO `sendable===true` (a diferencia del
     `TemplateSelector` del bulk que muestra disabled los no aprobados — acá el catálogo completo
     es ruido: el agente no administra templates desde el hilo).
  2. Form de variables: un `<input>` por variable declarada, label `{{N}}` visible (molde de ids/
     labels de `VariablesMapForm.tsx:110-140`, SIN el Select de fuentes — D8).
  3. Preview del mensaje real: body con placeholders sustituidos por el valor tipeado (patrón
     `renderPreviewMessage`/`splitTemplateBody`, `previewMessage.ts:25-35` /
     `VariablesMapForm.tsx:34-46`) — variable vacía se muestra resaltada como pendiente.
  4. Confirm deshabilitado hasta: template elegido + TODAS las variables no-vacías (mirror del
     422 server-side, que igual se maneja — defensa en profundidad, no reemplazo).
- **4 ramas de estado del catálogo** (patrón `TemplateSelector.tsx:46-64`): loading (`role=status`),
  error (`role=alert` + retry), empty ("No hay templates aprobados." — nota: empty = lista SIN
  aprobados, aunque haya pending/rejected), success.
- **Errores de envío**: `mapSendError` extendido (única superficie de mapeo, `mapSendError.ts`)
  con: `TEMPLATE_NOT_APPROVED`, `MISSING_TEMPLATE_VARIABLES`, `TEMPLATE_SEND_REJECTED`,
  `TEMPLATE_PROVIDER_UNAVAILABLE`, `TEMPLATE_PROVIDER_MISCONFIGURED`, `CONVERSATION_PHONE_MISSING`.
  Mostrados inline en el modal (`role="alert"`), modal queda abierto para corregir/reintentar.
- **Motion**: entrada/salida del modal y el swap de ramas según Emil — se define en el apply
  (transform+opacity, respeta `prefers-reduced-motion`), NO en este plan.

## Colisiones con `inbox-resolve` (plan commiteado en worktree `inbox-resolve-be`, 46130d2f)

| Archivo | inbox-resolve | inbox-template-send | Veredicto |
|---|---|---|---|
| BE `messaging.routes.ts` | modifica handler GET `/conversations` (parsing `?status=`) | agrega 2 rutas nuevas + 2 args a la factory | mismo archivo, regiones distintas — conflicto textual menor, merge trivial |
| BE `domain/ports/ConversationRepository.ts` | agrega campo a `ConversationListQuery` | agrega método `bumpLastMessage` | regiones distintas — merge trivial |
| BE `InMemory/PrismaConversationRepository` | filtro en `list()` | método nuevo | regiones distintas |
| BE `__tests__/infrastructure/messaging.routes.test.ts` | agrega tests | agrega tests | append-only |
| BE `app.ts` | sin cambios (su T3 es passthrough) | wiring nuevo | solo este change |
| FE `types/whatsapp.ts`, `whatsapp.api.ts`, `useWhatsapp.ts` | agrega `status` a query/list | agrega api fns + hooks nuevos | append-only, regiones distintas |
| FE `WhatsappInboxPage.tsx` | rewire de lista/tabs | **NO SE TOCA** (restricción de diseño: todo vive en el subtree de `Composer`) | sin overlap |
| FE `ConversationList*`, `ConversationStatusFilter` | suyos | no | sin overlap |
| FE `Composer.tsx` + componentes nuevos, `mapSendError.ts` | no | nuestros | sin overlap |

**No hay overlap semántico** (ninguno modifica una línea que el otro modifique). Recomendación:
merge secuencial en cualquier orden, rebase del segundo antes de pushear. OJO: el tasks.md de
`inbox-resolve` afirma "Ningún change BE en vuelo toca messaging" — quedó DESACTUALIZADO al nacer
este change; el orquestador debe avisarle.

## Testing (Strict TDD — matriz completa en specs/tasks)

- Use case con fakes: `InMemoryConversationRepository` + `InMemoryChatMessageRepository`
  (extendidos con los métodos nuevos, test-first) + `InMemoryTemplateMessagingGateway` (ya
  implementa `listTemplates`/`sendTemplate`, `adapters/in-memory/InMemoryTemplateMessagingGateway.ts`).
  NUNCA mock de Prisma.
- Rutas: supertest sobre la app con repos in-memory (401/403/400/404/422/503/201 + catálogo).
- FE: Testing Library — CTA gateado por rama de ventana, panel 4 ramas, gate de confirm, envío
  feliz (mensaje en el hilo), errores mapeados, a11y (dialog/labels/focus/Esc).
- E2E vivo al cierre (memoria `e2e-envelope-mock-mismatch`: los mocks no cazan mismatches de
  envelope — verificar `{data}` unwrap del catálogo y el flat del POST contra el BE real).
