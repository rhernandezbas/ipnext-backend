# Spec — inbox-template-send · BE (delta sobre messaging-inbox)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify).

Delta ADITIVO sobre `messaging-inbox`. NO reabre `SendMessage`/el path Chatwoot (LOCKED) ni el
send-path bulk (`SendCampaign`, LOCKED). Regla de plataforma transversal (design D2): **la ventana
de 24h la abre SOLO el inbound del cliente — enviar un template NUNCA la abre**.

---

## Capability: modelo — traza del envío one-off

### Requirement: MODEL-1 — `ChatMessage.providerMessageId`

El schema MUST ganar `providerMessageId String? @unique` en `ChatMessage` (migración aditiva vía
`prisma migrate dev`, jamás SQL a mano). Nullable: las filas `chatwoot`/`bulk` existentes quedan
`NULL` (PG trata NULLs como distintos en el UNIQUE — conviven N filas).

#### Scenario: migración no rompe filas existentes
- Given un mirror con mensajes `origin:'chatwoot'` y `origin:'bulk'`
- When corre la migración
- Then todas las filas quedan con `providerMessageId = NULL` y los tests existentes siguen verdes

---

## Capability: ports — proyección one-off al hilo

### Requirement: PORT-1 — `ChatMessageRepository.upsertTemplateMessage`

El port MUST ganar `upsertTemplateMessage(input): Promise<ChatMessageRecord>` con input
`{conversationId, providerMessageId, content, senderName?, chatwootCreatedAt}`. La fila resultante
MUST tener `origin:'agent_template'`, `direction:'outbound'`, `chatwootMessageId:null`,
`campaignRecipientId:null`, `isPrivate:false`. MUST ser idempotente por `providerMessageId`
(upsert — re-proyectar el mismo SM sid nunca duplica). Ambos adapters (`InMemory`, `Prisma`) MUST
implementar la MISMA semántica. `ChatMessageRecord` MUST exponer `providerMessageId` (aditivo).

#### Scenario: upsert idempotente por providerMessageId
- Given un `upsertTemplateMessage` ya ejecutado con `providerMessageId:'SM123'`
- When se re-ejecuta con el mismo `providerMessageId`
- Then sigue habiendo UNA sola fila para `SM123` en la conversación

#### Scenario: la fila proyectada aparece en el hilo
- Given una conversación con mensajes chatwoot previos y un `upsertTemplateMessage` posterior
- When `listByConversation(conversationId)`
- Then el mensaje template aparece ordenado por `chatwootCreatedAt` ASC junto a los demás
  (listado origin-agnóstico, sin filtro nuevo)

### Requirement: PORT-2 — `ConversationRepository.bumpLastMessage`

El port MUST ganar `bumpLastMessage(conversationId, {lastMessageAt, lastMessagePreview}):
Promise<ConversationRecord | null>` (null si no existe). MUST escribir SOLO esos dos campos:
`canReply`, `status`, `assigneeId`, `areaId`, `chatwootConversationId`, `origin` y todo lo demás
MUST quedar intactos (write-path separado, misma disciplina que `updateLocalFields`). Ambos
adapters MUST implementar la MISMA semántica.

#### Scenario: bump no toca canReply ni status (regla de plataforma)
- Given una conversación `{canReply:false, status:'open', assigneeId:'u1'}`
- When `bumpLastMessage(id, {lastMessageAt: T, lastMessagePreview: 'Hola Juan…'})`
- Then `lastMessageAt`/`lastMessagePreview` cambian y `canReply` sigue `false`, `status` `'open'`,
  `assigneeId` `'u1'`

---

## Capability: use case — SendTemplateMessage

### Requirement: TS-1 — orden de guards PINNED, sin side effects antes del envío

`SendTemplateMessage.execute(conversationId, templateRef, variables, senderName?)` MUST evaluar en
este orden, cortando en la primera falla y SIN persistir nada ni llamar a `sendTemplate` hasta el
paso 5: (1) conversación existe, (2) teléfono resoluble, (3) template aprobado, (4) variables
completas, (5) envío. Dependencias SOLO por ports (`ConversationRepository`,
`TemplateMessagingPort`, `ChatMessageRepository`) — DIP estricto, jamás Prisma/axios.

#### Scenario: conversación inexistente
- When `execute('nope', 'HX1', {})`
- Then lanza `ConversationNotFoundError` (→ 404) y el gateway fake registra CERO llamadas a
  `sendTemplate`

### Requirement: TS-2 — teléfono resoluble o 422

El destino MUST resolverse como `conversation.contactPhoneE164`, con fallback
`toWhatsAppE164(conversation.contactPhone)`. Si ambos resuelven `null` MUST lanzar el NUEVO
`ConversationPhoneMissingError` (code `CONVERSATION_PHONE_MISSING`, en `domain/errors/messaging.ts`,
mapeado a 422 en el statusMap del errorHandler).

#### Scenario: conversación sin teléfono
- Given una conversación con `contactPhoneE164:null` y `contactPhone:null`
- When `execute(...)`
- Then lanza `ConversationPhoneMissingError` y NO se llama a `sendTemplate`

#### Scenario: fallback de E164
- Given `contactPhoneE164:null` pero `contactPhone` convertible por `toWhatsAppE164`
- When `execute(...)`
- Then `sendTemplate` recibe el E164 derivado (con `+`)

### Requirement: TS-3 — template aprobado (criterio CAMP-2)

`templateRef` MUST corresponder a un template con `approvalStatus === 'approved'` en
`templatePort.listTemplates()`. Inexistente en el proveedor MUST tratarse IGUAL que no-aprobado
(sin evidencia de aprobación) → `TemplateNotApprovedError` (→ 422).

#### Scenario: template pending
- Given el fake con un template `pending` de contentSid `HX9`
- When `execute(conv, 'HX9', {...})`
- Then lanza `TemplateNotApprovedError` y CERO llamadas a `sendTemplate`

#### Scenario: template inexistente
- When `execute(conv, 'HX-no-existe', {})`
- Then lanza `TemplateNotApprovedError`

### Requirement: TS-4 — variables completas (criterio CAMP-3)

TODAS las variables declaradas por el template (`Object.keys(template.variables)`) MUST estar
presentes como keys en `variables`; si faltan MUST lanzar `MissingTemplateVariablesError(missing)`
(→ 422, lleva los nombres faltantes). Variables EXTRA no declaradas MUST NOT bloquear.

#### Scenario: falta una variable
- Given un template aprobado que declara `{1,2}`
- When `execute(conv, ref, {'1':'Juan'})`
- Then lanza `MissingTemplateVariablesError` con `missing:['2']` y CERO envíos

### Requirement: TS-5 — envío por el port, errores tipados propagan, SIN retry interno

El envío MUST ser `templatePort.sendTemplate(phoneE164, templateRef, variables)` SIN envolver en
`sendWithRetry` (one-off interactivo, design D6). `TemplateSendRejectedError` /
`TemplateProviderUnavailableError` / `TemplateProviderConfigError` MUST propagar tal cual (→
422/503/503 vía statusMap). En falla del envío MUST NOT persistirse NADA (ni ChatMessage ni bump).

#### Scenario: Twilio rechaza (4xx per-mensaje)
- Given el fake configurado para lanzar `TemplateSendRejectedError`
- When `execute(...)`
- Then el error propaga y el mirror queda EXACTAMENTE como estaba (cero mensajes nuevos, preview
  intacto)

#### Scenario: proveedor caído
- Given el fake lanza `TemplateProviderUnavailableError`
- Then propaga y cero persistencia

### Requirement: TS-6 — proyección al hilo + bump post-OK

Tras el envío aceptado, el use case MUST: (a) renderizar el body con `renderTemplateBody(
template.body, variables)` (reuso de la función exportada de `SendCampaign.ts` — body vacío →
`''`, degradación segura); (b) `upsertTemplateMessage` con `providerMessageId = result.providerId`,
`content = renderedBody`, `senderName` recibido, `chatwootCreatedAt = sentAt` (ISO generado en el
use case); (c) `bumpLastMessage(conversationId, {lastMessageAt: sentAt, lastMessagePreview:
renderedBody})`; (d) devolver `toChatMessageDto(record, [])` — NUNCA la fila cruda.

#### Scenario: happy path completo
- Given conversación con teléfono, template aprobado `body:'Hola {{1}}, debés {{2}}'` y
  `variables:{'1':'Juan','2':'$5.000'}`
- When `execute(...)`
- Then `sendTemplate` recibió `(E164, contentSid, variables)`; existe UN ChatMessage
  `{origin:'agent_template', direction:'outbound', content:'Hola Juan, debés $5.000',
  chatwootMessageId:null, providerMessageId:'SM…'}`; la conversación tiene
  `lastMessagePreview:'Hola Juan, debés $5.000'`; el DTO devuelto tiene `direction:'outbound'`,
  `content` renderizado y `sentAt = lastMessageAt`

#### Scenario: el envío NO abre la ventana
- Given la conversación con `canReply:false`
- When el happy path completa
- Then `canReply` sigue `false` (y `status` intacto) — regla de plataforma D2

#### Scenario: enviable también dentro de ventana
- Given la conversación con `canReply:true`
- When `execute(...)`
- Then el envío procede igual (el use case NO valida `canReply` en ninguna dirección)

---

## Capability: HTTP — rutas nuevas en `createMessagingRouter`

### Requirement: HTTP-1 — `POST /api/messaging/conversations/:id/send-template`

La ruta MUST estar gateada por `auth` + `perms.send` (el MISMO guard del envío actual —
`requirePerm('messaging','send')`; documentado: NO existe permiso nuevo). Body JSON
`{templateRef, variables?}`. MUST responder 400 `VALIDATION_ERROR` si `templateRef` está
ausente/no-string/vacío, o si `variables` está presente y no es un objeto plano con valores
string (ausente → `{}`). Handler async con try/catch → `next(err)`; los DomainErrors resuelven vía
statusMap: 404 `CONVERSATION_NOT_FOUND`, 422 `CONVERSATION_PHONE_MISSING` /
`TEMPLATE_NOT_APPROVED` / `MISSING_TEMPLATE_VARIABLES` / `TEMPLATE_SEND_REJECTED`, 503
`TEMPLATE_PROVIDER_UNAVAILABLE` / `TEMPLATE_PROVIDER_MISCONFIGURED`. Éxito → 201 con el
`ChatMessageDto` FLAT (mismo envelope que `POST .../messages`). `senderName` MUST salir de
`req.user?.username` (nunca del body). MUST NOT montarse multer ni el `sendRateLimiter` (JSON-only).

#### Scenario: 401 sin sesión
- When POST sin cookie de sesión
- Then 401

#### Scenario: 403 sin messaging:send
- Given un usuario autenticado SIN `messaging:send`
- Then 403 (y con `messaging:send` pero acción de otro módulo, sigue 403)

#### Scenario: 400 body malformado
- When POST `{}` o `{templateRef: 42}` o `{templateRef:'HX1', variables:{'1': 7}}`
- Then 400 `{code:'VALIDATION_ERROR'}` y el use case NUNCA se invoca

#### Scenario: 201 happy path
- When POST `{templateRef:'HX1', variables:{'1':'Juan'}}` válido
- Then 201 con el DTO del mensaje (flat, `direction:'outbound'`) y el mensaje listado por
  `GET /conversations/:id/messages`

#### Scenario: 422 tipados pasan por el errorHandler
- Given un template no aprobado / conversación sin teléfono / variable faltante
- Then 422 con `{code}` correspondiente (nunca 500)

### Requirement: HTTP-2 — `GET /api/messaging/send-templates`

Catálogo para el picker del composer. MUST estar gateado por `auth` + `perms.send` (design D7 —
coherencia de capacidad; NO `messaging.templates`). MUST reusar el use case `ListTemplates` tal
cual y responder `{data: TemplateSummaryDto[]}` (mismo shape/envelope que
`GET /api/messaging/bulk/templates`). El path MUST ser `/send-templates` (nunca `/templates`, que
shadowearía el router CRUD montado en `/api/messaging/templates`).

#### Scenario: 401/403
- Sin sesión → 401; sin `messaging:send` → 403

#### Scenario: 200 con el catálogo completo curado
- Given el fake con templates approved y pending
- Then 200 `{data:[...]}` incluye ambos con su `sendable` correcto (el FE filtra; el server-side
  de verdad es TS-3 en el POST)

### Requirement: HTTP-3 — wiring en `app.ts`

El bloque del messaging router MUST instanciar su propio `TwilioContentGateway` (config
`config.twilio.*`, precedente self-contained del bloque templates-CRUD) y cablear
`new ListMessagingTemplates(gateway)` + `new SendTemplateMessage(conversationRepo,
gateway, chatMessageRepo)` como args nuevos de `createMessagingRouter`. La composición MUST quedar
cubierta por el test de rutas supertest (la app real compone sin romper los tests existentes del
router).

#### Scenario: rutas existentes no regresionan
- When corre la suite completa del router messaging
- Then todos los tests previos (webhook/list/get/messages/status/assignee/area/attachments)
  siguen verdes con la factory extendida
