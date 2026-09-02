# Proposal: external-bulk-messaging — envío masivo WhatsApp desde la API Externa (2 pasos, key dedicada)

## Intent

Que una IA/skill dispare envíos masivos por WhatsApp (números LIBRES + template aprobado +
label de Chatwoot) sin sesión de admin, con validaciones FUERTES: hay plata real y el número
de WhatsApp Business en juego. Hoy la única superficie M2M (`/api/external/v1`) es read-only +
tickets/news, y toda la maquinaria de campañas (`CreateCampaign`, `matchManualContacts`,
`resolveCombinedRecipients`, `CampaignRunner`) existe pero solo se alcanza con cookie de admin.

## Scope

### In Scope (BE)
- `POST /api/external/v1/messaging/bulk/validate` → preview + `previewId` (TTL ~15 min).
- `POST /api/external/v1/messaging/bulk/send` → exige `previewId` + header `Idempotency-Key`.
- Tabla nueva `ExternalBulkPreview` (no es `Campaign`: no ensucia el historial admin ni consume cupo).
- `Campaign.externalIdempotencyKey String? @unique` (molde `ChatMessage.idempotencyKey`).
- Key dedicada `EXTERNAL_MESSAGING_API_KEY` (opt-in, fail-closed) vía `createApiKeyMiddleware(key)`.
- Feature flag kill-switch `messaging-external-bulk-enabled` (seed DARK por migración) + singleton
  `ExternalBulkMessagingConfig` con los topes (500/request, 2000/día), `PATCH` desde admin.
- Validación VIVA del label contra Chatwoot (`ListChatwootLabels`); nunca se auto-crea.
- `RbacUser` M2M dedicado `api-messaging` (bootstrap como `api` en `main.ts`) = `Campaign.createdById`.
- **Variables POR-RECIPIENT (v1)**: `recipients: {phone, name?, variables?}[]`; el `variables` del
  recipient pisa al GLOBAL por key. Merge incompleto ⇒ ESE recipient cae en `invalid`
  (`variables_faltantes`), NO se rechaza el lote. Persistencia en `CampaignRecipient.variables Json?`
  y override en el envío (`SendCampaign`).
- **Templates desde la API Externa** (mismo router, misma key, mismo kill-switch):
  `GET /templates`, `GET /templates/:sid`, `POST /templates`, `POST /templates/:sid/submit` —
  reusando `ListTemplates`/`GetTemplate`/`CreateTemplate`/`SubmitTemplateForApproval` sin lógica nueva.

### In Scope (FE, repo `ipnext-frontend`, cambio coordinado — se DESCRIBE, no se implementa acá)
- Card nueva en `WhatsappSettingsPage.tsx` (molde `ChatwootSendPathCard.tsx`): toggle del
  kill-switch con confirm + banner "estado desconocido", y 2 inputs numéricos para los topes.

### Out of Scope
- Texto libre (rechazado por contrato: solo template aprobado + variables).
- Cola/backoff del `CampaignRunner` (sigue lock GLOBAL sin cola; se expone honesto, no se arregla).
- Dedup cross-campaña ("ya contactado hoy") — riesgo documentado, no resuelto.
- Costo en $ (no existe tarifa modelada en el repo: el preview reporta CONTEOS).
- Scopes/keys por consumidor; UI admin de previews externos.
- **`DELETE /templates/:sid` NO se expone** (decisión del orquestador): el borrado es destructivo e
  irreversible en Meta (`deleteInWaba`). Una IA no borra templates; si hace falta, se borra desde la
  UI admin, que ya tiene el endpoint con su guard de campañas activas.
- Editar un template (Meta no lo permite post-submit: clonar + re-submit) y adjuntos/media.
- Variables con `source` no-literal (`name`/`balanceDue`) desde la API: el caller externo no conoce
  `Client`s — solo literales, globales o por-recipient.
- **Fase posterior**: skill `whatsapp-bulk-ipnext` — se escribe DESPUÉS de verificación en vivo.

## Capabilities

### New Capabilities
- `external-bulk-messaging`: contrato M2M de 2 pasos (validate/send), preview persistido con TTL
  y hash de payload, key dedicada, kill-switch, topes por request y diarios, idempotencia,
  validación de label y contrato honesto ante lock ocupado.

### Modified Capabilities
- `messaging-bulk`: **extensión ADITIVA, sin cambiar ningún requirement existente**. `SendCampaign`
  gana UN punto de override (`recipient.variables` pisa lo que resuelve `resolveCampaignVariables`)
  y la cadena `manualContacts → CampaignRecipient` gana un campo opcional. Con `variables = null`
  (todo lo que existe hoy) el comportamiento es BIT A BIT el mismo — la no-regresión está pineada
  por un scenario propio (SEND-10). El resto (`CreateCampaign`/`matchManualContacts`/
  `CampaignRunner`) se REUSA sin tocar su spec.

## Approach

1. **Preview ≠ Campaign.** `validate` normaliza a E.164 AR móvil, dedup, corre el opt-out por
   sufijo, renderiza el body del template (`renderTemplateBody`/`resolveCampaignVariables`),
   valida el label contra Chatwoot y persiste un `ExternalBulkPreview`. NO crea `Campaign` →
   no infla el cupo ni el historial admin.
2. **`send` re-valida TODO** contra el estado ACTUAL (flag ON, template sigue aprobado, topes,
   opt-out, hash del payload) y recién ahí crea la `Campaign` vía `CreateCampaign` con
   `createdById = api-messaging` y `externalIdempotencyKey`.
3. **Cupo diario** = `CampaignRecipient` en `sent` de campañas cuyo `createdById` es
   `api-messaging`, dentro del día calendario Argentina. Se cuenta lo ENVIADO, no lo creado:
   un lote que rebota por lock no quema cupo y una campaña a medias solo quema lo que salió.
4. **Recipients sin nombre**: convención `name = <E.164>` para pasar la validación de
   `manualContacts` (que exige `name` no vacío); documentado en la spec.
5. **Lock ocupado → 409 honesto** con `retryAfterSeconds` + `campaignId`. Reintentar `send` con
   el mismo `previewId` + `Idempotency-Key` NO crea otra campaña: reanuda/arranca la existente.

## Data model sketch

| Modelo | Campos |
|--------|--------|
| `ExternalBulkPreview` (NEW) | `id`, `payloadHash` (canónico), `recipients Json` (normalizados), `invalid Json` (`{input, reason}`), `templateName`, `variables Json`, `chatwootLabel String?`, `validCount`, `invalidCount`, `expiresAt`, `consumedAt DateTime?`, `campaignId String? @unique`, `createdAt` |
| `Campaign` (MOD) | `+ externalIdempotencyKey String? @unique` |
| `CampaignRecipient` (MOD) | `+ variables Json?` — literales POR-RECIPIENT (nullable/aditiva; `null` en todo lo pre-existente y en los dominios segment/manual/csv/task) |
| `ExternalBulkMessagingConfig` (NEW, singleton) | `id @default("singleton")`, `maxPerRequest Int @default(500)`, `maxPerDay Int @default(2000)`, `updatedAt` |
| `FeatureFlag` (seed) | `messaging-external-bulk-enabled = false` (DARK, `INSERT ... ON CONFLICT DO NOTHING`) |

## API contract sketch

`POST /validate` → `{ templateName, variables?, chatwootLabel?, recipients: {phone, name?, variables?}[] }`
→ **200** `{ previewId, expiresAt, renderedMessage /*muestra del 1er válido*/, counts:{received,valid,invalid,optedOut,duplicated}, valid:[{phone,name,variables,renderedMessage}], invalid:[{input,reason,missingVariables?}], caps:{maxPerRequest,maxPerDay,remainingToday} }`

`GET /templates` → **200** `{ data: [{contentSid,friendlyName,language,variables[],approvalStatus,category,sendable,body}] }`
`GET /templates/:sid` → **200** el mismo DTO curado (estado vivo contra Meta) | **404** `TEMPLATE_NOT_FOUND`
`POST /templates` `{friendlyName,language,body,category?,variables?[]}` → **201** DTO (`unsubmitted`) | **400** `VALIDATION_ERROR`
`POST /templates/:sid/submit` `{name,category}` → **202** `{contentSid,submitted:true}` | **400** / **404**
`DELETE /templates/:sid` → **404** (no existe la ruta: el borrado NO se expone)

`POST /send` (header `Idempotency-Key`) → `{ previewId }`
→ **202** `{ campaignId, accepted:true, total }` | **409** `{ code:'CAMPAIGN_RUNNER_BUSY', campaignId, retryAfterSeconds }`

| Código | HTTP | Cuándo |
|--------|------|--------|
| `UNAUTHORIZED` | 401 | key dedicada ausente/inválida (fail-closed si no está configurada) |
| `FEATURE_DISABLED` | 403 | kill-switch OFF (fail-safe a OFF si el repo de flags falla) |
| `VALIDATION_ERROR` | 400 | body mal formado, texto libre, `phones` vacío, sin `Idempotency-Key` |
| `CAP_EXCEEDED` | 422 | > `maxPerRequest`, o `valid` supera el remanente diario |
| `TEMPLATE_NOT_APPROVED` / `MISSING_TEMPLATE_VARIABLES` | 422 | template inexistente/no aprobado; variables faltantes |
| `CHATWOOT_LABEL_NOT_FOUND` | 422 | el label no existe en el catálogo vivo (jamás se crea) |
| `CHATWOOT_UNAVAILABLE` | 503 | no se pudo consultar el catálogo (no se acepta a ciegas) |
| `PREVIEW_NOT_FOUND` / `PREVIEW_EXPIRED` / `PREVIEW_ALREADY_CONSUMED` | 404 / 410 / 409 | ciclo de vida del preview |
| `PREVIEW_PAYLOAD_MISMATCH` | 409 | hash distinto con el mismo `previewId` (nunca éxito silencioso) |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | misma key, distinto `previewId` |

**RBAC/auth**: M2M puro, sin `req.user`; key dedicada + rate-limiter de escritura externa.
`Campaign.createdById = api-messaging` (RbacUser dedicado) es el rastro de origen — evita inventar
`Campaign.source`. La auditoría global seguirá registrando `actorLogin:'anonymous'` (gap heredado
de `POST /tickets`): se mitiga con un log/evento propio que identifique origen externo.

## Affected Areas

| Área | Impacto |
|------|---------|
| `prisma/schema.prisma` + migrations | NEW 2 tablas, +2 columnas (`Campaign.externalIdempotencyKey`, `CampaignRecipient.variables`), seed del flag — TODO en UNA migración |
| `matchManualContacts` / `resolveCombinedRecipients` / `CreateCampaign` / `SendCampaign` | MOD **aditiva**: `variables?` opcional viajando de `manualContacts` a `CampaignRecipient` y override en el render. Backward compatible: la UI admin nunca lo manda ⇒ `null` ⇒ comportamiento idéntico |
| `domain/ports/` (`ExternalBulkPreviewRepository`, `ExternalBulkMessagingConfigRepository`) | NEW |
| `application/use-cases/messaging/ValidateExternalBulk.ts`, `SendExternalBulk.ts` | NEW |
| `infrastructure/adapters/prisma|in-memory/` | NEW repos (par Prisma + InMemory) |
| `infrastructure/http/routes/externalMessagingBulk.routes.ts` | NEW |
| `infrastructure/config.ts` | `+externalMessaging.apiKey` (opt-in) |
| `infrastructure/bootstrap/bootstrapSystemUsers.ts` + `main.ts` | `+api-messaging` |
| `infrastructure/http/app.ts` | ⚠️ **God Object (deuda HIGH)**: mount + wiring. Debe montarse ANTES del `app.use('/api/external/v1', createApiKeyMiddleware(), ...)` de L3730, si no la key GLOBAL intercepta la ruta nueva |
| `ipnext-frontend` `WhatsappSettingsPage.tsx` + card nueva | Cambio coordinado |

Sin dependencias nuevas de Splynx.

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Envío masivo indebido (plata + número en riesgo) | Media | 2 pasos obligatorios + flag DARK + topes + key dedicada + solo template aprobado |
| Doble envío del mismo lote | Media | `externalIdempotencyKey @unique` + `consumedAt` + `campaignId` en el preview |
| Mismo número en 2 lotes del día (double-send real) | Media | NO resuelto: riesgo aceptado y documentado; el cupo limita cantidad, no duplicados |
| Orden de mounts en `app.ts` (key global gana) | Media | Test de composition-root: 401 con la key global, 200 con la dedicada |
| 3 de 4 lotes rebotan por el lock global | Alta | 409 honesto con `retryAfterSeconds`; la skill hace poll+retry |
| Preview stale (template desaprobado entre validate y send) | Media | `send` re-valida todo; TTL corto (15 min) |
| Flag/config repo caído | Baja | Fail-safe a OFF / a los topes por defecto |
| **Variables por-recipient ⇒ más formas de mandarle el dato EQUIVOCADO al número equivocado** (el nombre de otro, la deuda de otro) | **Alta** | El preview es la salvaguarda: `valid[]` devuelve el `variables` MERGEADO y el `renderedMessage` DE CADA destinatario — el humano/la IA ve el mensaje exacto de cada uno antes de autorizar; el `payloadHash` incluye las variables por-recipient, así que cambiar una entre `validate` y `send` rompe el hash |
| Merge incompleto silencioso (placeholder vacío en el mensaje real) | Media | `variables_faltantes` invalida a ESE recipient con las keys faltantes; nunca se envía un `{{n}}` sin resolver |
| **Creación de templates desde una IA: cada creación quema un slot de review de Meta** | Media | `POST /templates` crea `unsubmitted` (cero costo en Meta); el **submit es explícito y separado** (TPL-4) — la IA no puede submitir sin una segunda llamada deliberada. Ambos POST auditados; el kill-switch los apaga junto con el bulk |
| Borrado accidental de un template en uso | — | NO se expone `DELETE` (scope-out); el borrado sigue solo en la UI admin con su guard |

## Rollback Plan

1. Kill-switch OFF desde Config → WhatsApp (efecto inmediato, sin deploy) o vaciar
   `EXTERNAL_MESSAGING_API_KEY` (fail-closed 401).
2. Revert del mount en `app.ts` → la ruta deja de existir; nada más del sistema la referencia.
3. Las 2 tablas nuevas y `Campaign.externalIdempotencyKey` son aditivas y nullable: quedan
   inertes sin migración inversa. El `RbacUser api-messaging` es inofensivo si nadie lo usa.

## Dependencies

- Chatwoot accesible para validar el label (si no, 503 explícito).
- Templates aprobados en el catálogo existente.
- FE `ipnext-frontend` para la card de Config → WhatsApp (coordinado, no bloqueante del BE).

## Success Criteria

- [ ] `validate` devuelve preview con conteos, inválidos con razón, mensaje renderizado y `previewId` con TTL.
- [ ] `send` sin `previewId` o sin `Idempotency-Key` → 400; con preview vencido/consumido/hash distinto → 410/409/409.
- [ ] Flag OFF → 403; key global (no la dedicada) → 401.
- [ ] > 500 por request o > 2000/día (contados sobre `sent`) → 422 `CAP_EXCEEDED`.
- [ ] Label inexistente → 422; Chatwoot caído → 503; nunca se crea un label.
- [ ] Reintento de `send` con mismo `previewId` + `Idempotency-Key` NO crea una segunda `Campaign`.
- [ ] Lock ocupado → 409 con `retryAfterSeconds` y `campaignId`.
- [ ] Números con opt-out (match por sufijo) excluidos del preview y del envío.
- [ ] `npm test` verde + `tsc --noEmit`; review adversarial 0 CRITICAL/0 HIGH.
- [ ] Fase posterior: verificación en vivo y recién después la skill `whatsapp-bulk-ipnext`.

## Open Questions (requieren al usuario)

Ninguna. Las 3 aperturas de la exploración quedan resueltas acá (tabla nueva, `RbacUser`
dedicado, 409 honesto). El resto es materia de `sdd-design`.
