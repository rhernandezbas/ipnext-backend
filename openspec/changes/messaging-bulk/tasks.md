# Tasks — messaging-bulk (F2: envío masivo por template WhatsApp)

**Change**: messaging-bulk · **Phase**: tasks · **Project**: ipnext-backend
**Reads (LOCKED, no se reabren acá)**: `design.md` (11 secciones, send-path Twilio directo), `specs/messaging-bulk/spec.md` (26 requirements / ~60 escenarios Given/When/Then).
**Convención TDD**: cada tarea de código lista el TEST primero. Jest + adapters in-memory — **NUNCA mockear Prisma** (usar el port in-memory o un fake mínimo). Un test por escenario del spec como piso; el nombre del test cita el requirement (`SEG-2 — excluye opt-out del count`). Un batch no se da por cerrado sin verde. Path aliases (`@domain/*`, `@application/*`, `@infrastructure/*`) siempre — nunca `../../../`. NO correr `npm run build`/`prisma migrate`/`npm test` — eso lo decide el usuario en `apply`.

---

## ⚠️ Contradicciones detectadas contra design.md/spec.md — resolver ANTES de picar código

Estas NO son nitpicks: si se ignoran, `apply` produce algo que no matchea el spec o rompe la promesa de personalización del bulk. Cada una queda anotada en el batch donde pega.

1. **Rutas: design.md §7 vs spec.md NO coinciden.** Design propone `GET /api/messaging/templates`, `POST /api/messaging/campaigns`, `POST /api/messaging/campaigns/:id/send`, etc. (prefijo `/api/messaging/...`). El spec (TPL-1, RBAC-1/2, HIST-1/2) usa **`/api/messaging/bulk/templates`**, **`/api/messaging/bulk/segment/preview`**, **`/api/messaging/bulk/campaigns`**, **`/api/messaging/bulk/campaigns/:id`**. `sdd-verify` valida contra el spec → **el spec manda**. Batch 7 implementa con prefijo `/api/messaging/bulk`, NO el de design.md.
2. **`CreateCampaign` necesita `TemplateMessagingPort`, y el wiring de design §7 no se lo pasa.** CAMP-2 exige validar `templateRef` aprobado llamando a `TemplateMessagingPort.listTemplates()` — pero el snippet de app.ts en design §7 instancia `new CreateCampaign(campaignRepo, customerRepo)` (2 args, sin el port). Batch 3 define `CreateCampaign(campaignRepo, customerRepo, templatePort)` (3 args); batch 7 corrige el wiring real, no copia el snippet de design tal cual.
3. **`variableSpec` (design, dinámico por-destinatario) vs `variablesMap` (spec CAMP-1/CAMP-3, validado como mapa fijo al crear) — la MISMA estructura descripta con semántica distinta.** Design §1.1/§3.3: `variableSpec: Record<string, {source:'name'|'balanceDue'|'literal', value?}>`, resuelto **por-cliente** en `SendCampaign` (así "monto_deuda" varía por destinatario — el sentido de un recordatorio de deuda). Spec CAMP-3 solo pide que "TODAS las variables declaradas... estén presentes como keys en `variablesMap`" — leído literal, sugeriría un mapa de VALORES fijos idéntico para todos (rompería la personalización). **Resolución para batch 3**: `variablesMap`/`variableSpec` es el MISMO campo; CAMP-3 valida que estén las KEYS (nombres de variable), no que los VALUES sean literales fijos — cada entrada sigue siendo `{source, value?}` como en design. Documentarlo así en el DTO y dejar CONSTANCIA en el test de CAMP-3 de qué se está validando (presencia de key, no valor). Si el negocio de verdad quiere un mapa de valores fijos (sin personalización), es un cambio de spec, no de código — flag para el usuario.
4. **Gap de alcance en OPT-2**: `GetClientContextByPhone` (F1) resuelve por teléfono usando `CustomerRepository.listActiveContacts()`, que filtra `status: 'active'` — pero el bulk manda templates a `late`/`blocked`/`baja` (deudores, cortados, reenganche), que son EXACTAMENTE quienes más van a responder "BAJA". Si OPT-2 reusa `listActiveContacts()` tal cual, el opt-out de un cliente `late` NUNCA se registra (match vacío). Batch 6 resuelve esto con `listSegmentRecipients({ statuses: [] })` (statuses vacío = sin filtro de status, per SEG-1) para el matching de OPT-2, NO con `listActiveContacts()`.
5. **`SEND-1` (rechaza `start()` sobre campaña `done`) vs la recomendación de design §11.3 ("re-run manual reintenta `queued`+`failed`")**: una vez que TODOS los recipients terminan (mix `sent`+`failed`) el executor marca la campaña `done` (SEND-2: un failed aislado no aborta ni bloquea el cierre). Pero `SEND-1` bloquea re-invocar `start()` sobre una campaña `done` con `CampaignAlreadyFinishedError`. Conclusión: **hoy no hay forma de reintentar los `failed` de una campaña ya `done`** — el resume de `queued`+`failed` en el loop (SEND-6) solo sirve para el caso "el worker se cayó a mitad de camino y la campaña quedó `running`" (crash-recovery), NO para "el operador quiere reintentar los fallidos de una campaña terminada". Ver open_flags — no se resuelve en v1 (documentado, no bloquea batch 4).

---

## Batch 1 — Schema + migraciones (aditivo, sin tests unitarios propios — validado por texto SQL + compilación)

### T1.1 — extender `prisma/schema.prisma`
Agregar (design §1.1-§1.3, EXACTO):
- `enum CampaignStatus { pending running paused done failed }`
- `enum CampaignRecipientStatus { queued sent delivered opted_out skipped failed }`
- `model Campaign` (17 campos + relation `recipients`, índices `@@index([status])` + `@@index([createdAt(sort: Desc)])`, FK `createdById → RbacUser` `onDelete: Restrict`)
- `model CampaignRecipient` (12 campos, `@@unique([campaignId, clientId])`, `@@index([campaignId, status])`, FKs cascade a `Campaign`/`Client`)
- `Client.whatsappOptOutAt DateTime?` + back-relation `campaignRecipients CampaignRecipient[]`

### T1.2 — migración aditiva de modelos (`prisma/migrations/20260908000000_messaging_bulk_campaigns/migration.sql`)
Generar con `npx prisma migrate diff --from-schema-datamodel <bak> --to-schema-datamodel prisma/schema.prisma --script` (NUNCA SQL a mano). Sketch exacto en design §1.4. Verificar antes de escribir: el último folder en `prisma/migrations/` es `20260907000000_add_conversation_assignment` → `20260908000000` no colisiona.

### T1.3 — migración RBAC idempotente (`prisma/migrations/20260908000100_messaging_bulk_permissions/migration.sql`)
Molde **exacto** `20260904000100_messaging_permissions/migration.sql` (leído completo — 7 bloques `INSERT...ON CONFLICT DO NOTHING`): módulo `messaging` ya existe (re-INSERT idempotente por si corre en DB fresca) + siembra `bulk`/`templates` bajo `messaging` + 4 grants (`bulk`+`templates` × `super_admin`+`administrador`, 4 bloques en vez de los 2 del molde de F1).

### T1.4 — `domain/entities/rbac.ts`: agregar `'bulk'` y `'templates'` a `KNOWN_ACTIONS`
Sin esto `requirePerm('messaging','bulk')` no compila (design §1.5). Insertar tras el comentario `// messaging-inbox (F1)... 'send',` con comentario propio `// messaging-bulk (F2) — disparar/ver campañas masivas + listar/usar templates`.

**TEST QUE ROMPE Y HAY QUE ACTUALIZAR (no ignorar)**: `src/__tests__/domain/entities/rbac.test.ts:143` tiene `expect(KNOWN_ACTIONS).toHaveLength(45)` — pasa a **47**. Actualizar ese assert como parte de este batch (no es un test nuevo, es mantenimiento del contrato existente — mismo criterio que cualquier extensión de `KNOWN_ACTIONS` pasada).

### T1.5 — test estático de las migraciones (molde EXACTO `src/__tests__/infrastructure/messaging-migration.test.ts`)
Nuevo archivo `src/__tests__/infrastructure/messaging-bulk-migration.test.ts`:
- lee `rbac.ts` crudo → `expect(rbacSrc).toMatch(/'bulk',/)` + `/'templates',/`
- lee `20260908000000_messaging_bulk_campaigns/migration.sql` → assert `CREATE TYPE "CampaignStatus"`, `CREATE TYPE "CampaignRecipientStatus"`, `CREATE TABLE "Campaign"`, `CREATE TABLE "CampaignRecipient"`, `ALTER TABLE "Client" ADD COLUMN "whatsappOptOutAt"`, el `@@unique` compuesto, los 2 índices.
- lee `20260908000100_messaging_bulk_permissions/migration.sql` → assert `ON CONFLICT` en los 7 bloques (idempotencia), acciones `'bulk'`/`'templates'`.

Escribir el test PRIMERO (falla porque los archivos no existen) → escribir T1.1-T1.4 → verde.

---

## Batch 2 — Domain (entities/DTOs/errores/ports) — depende de Batch 1

### T2.1 — DTOs curados (`application/dto/messaging-bulk.dto.ts`, co-located con `messaging.ts` existente)
`TemplateSummaryDto`, `CampaignDto`, `CampaignSummaryDto`, `CampaignRecipientDto` (status `opted_out` → display `'opted-out'`, HIST-3: `error` saneado nunca el crudo del proveedor), `CreateCampaignInput`/`Output`, `PreviewSegmentInput`/`Output` (con `excludedOptOut`/`excludedNoPhone`/`dedupCollapsed` per design, mapeados a los nombres del spec `skipped.optedOut`/`skipped.duplicatePhone`/`skipped.invalidPhone` — **usar los nombres del spec** en el DTO de salida, no los de design, por la misma regla de "el spec manda" del punto 1 arriba).

### T2.2 — errores tipados (`domain/errors/messaging-bulk.ts`, nuevo archivo — no mezclar con `messaging.ts` de F1)
`TemplateProviderUnavailableError` (`TEMPLATE_PROVIDER_UNAVAILABLE`), `TemplateSendRejectedError` (`TEMPLATE_SEND_REJECTED`), `TemplateNotApprovedError` (`TEMPLATE_NOT_APPROVED`, CAMP-2), `MissingTemplateVariablesError` (`MISSING_TEMPLATE_VARIABLES`, lleva `missing: string[]`, CAMP-3), `EmptySegmentError` (`EMPTY_SEGMENT`, CAMP-4), `CampaignNotFoundError` (`CAMPAIGN_NOT_FOUND`, HIST-2), `CampaignAlreadyFinishedError` (`CAMPAIGN_ALREADY_FINISHED`, SEND-1) — todas `extends DomainError`.

### T2.3 — registrar en `errorHandler.ts` `statusMap`
`TEMPLATE_PROVIDER_UNAVAILABLE: 503`, `TEMPLATE_SEND_REJECTED: 422`, `TEMPLATE_NOT_APPROVED: 422`, `MISSING_TEMPLATE_VARIABLES: 422`, `EMPTY_SEGMENT: 422`, `CAMPAIGN_NOT_FOUND: 404`, `CAMPAIGN_ALREADY_FINISHED: 409` (mismo criterio que `ICLASS_ALREADY_CLOSED: 409`).
**Test**: extender/crear `src/__tests__/infrastructure/messaging-bulk.errorHandler.test.ts` — un caso por código, assert status.

### T2.4 — ports (`domain/ports/TemplateMessagingPort.ts`, `domain/ports/CampaignRepository.ts`)
`TemplateMessagingPort` con `TemplateDto`/`SendTemplateResult` (design §2.1, verbatim). `CampaignRepository`: `create`, `findById`, `update` (patch parcial), `list(query)`, `bulkCreateRecipients(campaignId, rows[])`, `updateRecipient(id, patch)`, `listRecipients(campaignId, filter?)`. Sin tests propios (son interfaces) — se validan por los adapters de Batch 3.

### T2.5 — `toWhatsAppE164` (pura, `application/use-cases/messaging/toWhatsAppE164.ts`)
**TEST PRIMERO** (`src/__tests__/application/messaging/toWhatsAppE164.test.ts`): casos de design §2.3 — `'3364123456'` → `'+5493364123456'`; `'+54 9 3364 12-3456'` → idempotente (mismo resultado); ya-E164 sin `9` móvil → agrega el `9`; basura (`'123'`, `null`, `''`) → `null`. Implementar después. **Marcar en el test un comentario explícito**: el shape exacto (`+549` vs `+54`) es best-effort hasta el gate de verificación EN VIVO (batch 9) — si el test-send real muestra otro prefijo, este test se ajusta ahí, no antes.

---

## Batch 3 — Adapters in-memory + use cases de lectura/creación (TDD) — depende de Batch 2

### T3.1 — `InMemoryCampaignRepository` (`infrastructure/adapters/in-memory/InMemoryCampaignRepository.ts`)
Molde `InMemoryServiceCutBatchRepository.ts` (ya existe, mismo patrón Map-based) + soporte de recipients (`bulkCreateRecipients` respeta `@@unique[campaignId,clientId]` — upsert, no duplica; `listRecipients` filtra por `statusIn`). **Test primero** (`src/__tests__/infrastructure/adapters/in-memory/InMemoryCampaignRepository.test.ts`): create/findById/update (patch parcial)/list paginado/bulkCreateRecipients idempotente/listRecipients con filtro de status.

### T3.2 — fake `TemplateMessagingPort` (`infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway.ts`)
Array de `TemplateDto` inyectable en el ctor + `sendTemplate` que registra llamadas (`calls: {to, contentSid, variables}[]`) y devuelve `{providerId:'SMfake...', status:'queued'}`. Modo configurable: "falla el N-ésimo con 429" (lanza `TemplateProviderUnavailableError` con `retryAfterMs`) y "rechaza el número X" (lanza `TemplateSendRejectedError`). **Test primero** cubriendo los 3 modos.

### T3.3 — nota de gap: NO existe `InMemoryCustomerRepository` en el repo
Confirmado (`Glob **/InMemoryCustomerRepository.ts` → 0 resultados; `GetClientContextByPhone.test.ts` usa un objeto literal ad-hoc). **No construir un `InMemoryCustomerRepository` completo** (el port `CustomerRepository` tiene ~15 métodos, la mayoría fuera de scope acá) — cada test de Batch 3/4/6 define un `FakeCustomerRepository` MÍNIMO inline (implementa solo `list`/`listSegmentRecipients` con un objeto que castea `as CustomerRepository`, mismo patrón que `GetClientContextByPhone.test.ts`). Documentarlo así en cada test file para que no se repita la pregunta en `verify`.

### T3.4 — `ListTemplates` (`application/use-cases/messaging/ListTemplates.ts`)
**Test primero** (`src/__tests__/application/messaging/ListTemplates.test.ts`, TPL-1/TPL-2): mixto approved/pending → `sendable` correcto; provider lanza → propaga `TemplateProviderUnavailableError` sin colgar; lista vacía → `[]`. Impl: delega en el port, mapea a `TemplateSummaryDto`, `sendable = approvalStatus === 'approved'`, NUNCA expone el objeto crudo.

### T3.5 — `resolveRecipients` (helper puro compartido, `application/use-cases/messaging/resolveRecipients.ts`)
Extraído para que `PreviewCampaignSegment` y `CreateCampaign` NO dupliquen la lógica (design §3.3 paso 1). **Test primero**: dado un array de `CampaignRecipientCandidate` (clientId/name/phone/balanceDue/whatsappOptOutAt) — excluye opt-out (SEG-2), descarta `toWhatsAppE164(phone)===null` (SEG-4), de-dup por `normalizePhone` VERBATIM ganando el `id` menor (SEG-3) — devuelve `{ resolved: [...], excludedOptOut, excludedNoPhone, dedupCollapsed }`.

### T3.6 — `PreviewCampaignSegment` a.k.a. `CountRecipients` (`application/use-cases/messaging/PreviewCampaignSegment.ts`)
**Test primero** (`src/__tests__/application/messaging/PreviewCampaignSegment.test.ts`) — un caso por escenario SEG-1..SEG-5 (single status, multi-status unión, rango balanceDue + status combinado AND, rango sin status, sin matches, opt-out excluido, de-dup, teléfono inválido, no persiste nada — dos previews seguidos dan igual resultado y no tocan `CampaignRepository`). Usa `resolveRecipients` (T3.5) + `FakeCustomerRepository.listSegmentRecipients` (stub — implementación real recién en Batch 6, acá el fake alcanza). RBAC gate `messaging.bulk` se testea en la ruta (Batch 7), no acá.

### T3.7 — `CreateCampaign` (`application/use-cases/messaging/CreateCampaign.ts`)
**⚠️ contradicción #2/#3 arriba aplicadas acá**: constructor `(campaignRepo, customerRepo, templatePort)` — 3 args, NO 2. `variableSpec`/`variablesMap` valida PRESENCIA DE KEYS contra `TemplateDto.variables`, preserva `{source, value?}` por key.
**Test primero** (`src/__tests__/application/messaging/CreateCampaign.test.ts`) — CAMP-1..CAMP-4 completos: create exitoso (persiste `Campaign` pending + N `CampaignRecipient` queued, `sendTemplate` NUNCA invocado); template `pending`/inexistente → `TemplateNotApprovedError` sin persistir NADA (verificar `campaignRepo` sigue vacío); falta una variable → `MissingTemplateVariablesError` con `missing` correcto, nada persistido; variables extra no declaradas → NO bloquea; segmento vacío → `EmptySegmentError`, nada persistido.

### T3.8 — `GetCampaign` + `ListCampaigns` (`application/use-cases/messaging/{GetCampaign,ListCampaigns}.ts`)
**Test primero**: `GetCampaign` — header+contadores, recipients paginados opcionales filtrables por status, `CAMPAIGN_NOT_FOUND` en id inexistente (HIST-2). `ListCampaigns` — paginado, orden `createdAt DESC`, vacío → `{data:[]}` (HIST-1).

---

## Batch 4 — `SendCampaign` runner (TDD) — depende de Batch 2/3

### T4.1 — `RateLimiter` port + `ImmediateRateLimiter` (test) + `TokenBucketRateLimiter` (real)
`domain/ports/RateLimiter.ts` (`interface RateLimiter { acquire(): Promise<void> }`). `infrastructure/adapters/in-memory/ImmediateRateLimiter.ts` (no-op, para tests deterministas de SendCampaign). `application/util/TokenBucketRateLimiter.ts` — **test primero** (`src/__tests__/application/util/TokenBucketRateLimiter.test.ts`, molde de testabilidad `now()`/`sleep` inyectables de `GestionRealClient`): SEND-4 escenario "limiter consultado exactamente 1 vez por recipient ANTES de sendTemplate" + "el limiter frena, el recipient sigue procesándose (no falla/skip)".

### T4.2 — backoff 429-aware (clon de función, NO de archivo)
`application/use-cases/messaging/campaignBackoff.ts`: clonar `backoffMs`/`isRetryableAxiosError`/`retryAfterMs` de `GestionRealClient.ts:118-229` adaptado a los errores tipados del port (`TemplateProviderUnavailableError` en vez de `AxiosError` crudo — el mapeo axios→error tipado ya lo hizo el adapter en Batch 5). **Test primero**: exponencial `base·3^i+jitter`, respeta `retryAfterMs` del error, cap `maxBackoffMs`, params inyectables (`retryBaseMs`, `maxRetries`, `maxBackoffMs`, `sleep`, `random`).

### T4.3 — `SendCampaign` use case (`application/use-cases/messaging/SendCampaign.ts`)
Constructor `(campaignRepo, customerRepo, templatePort, rateLimiter, backoffOpts?)`. **Test primero** (`src/__tests__/application/messaging/SendCampaign.test.ts`) — un caso por SEND-2..SEND-7:
- SEND-2: 3 recipients, 2 OK + 1 error persistente → 2 `sent`+`sentAt`, 1 `failed`+`error`, campaña `done` (el failed no la marca `failed` global).
- SEND-3: 503×2 luego OK → termina `sent` (reintentos transparentes); 500×N agotados → `failed` con el error del último intento, el resto del batch sigue; 400 → `failed` en el PRIMER intento sin agotar reintentos.
- SEND-4: usa `ImmediateRateLimiter` salvo el caso específico que valida el conteo de invocaciones del limiter con un fake `RateLimiter` espía.
- SEND-5: opt-out ocurre ENTRE create y send (mutar `Client.whatsappOptOutAt` en el fake repo a mitad del loop) → recipient `opted-out` sin invocar `sendTemplate`, contabilizado en `optedOutCount` no en `sentCount`/`failedCount`.
- SEND-6: 5 recipients, 2 ya `sent` de una corrida previa + 3 `queued` → solo los 3 reciben `sendTemplate`.
- SEND-7: 30 recipients (> tamaño de página típico 25) todos `sent` → `Campaign.sentCount === 30` (NO derivado de `.length` de una llamada paginada — el fake repo debe simular paginación en `listRecipients` para que este test sea honesto, o el `InMemoryCampaignRepository` de T3.1 debe soportar traer el universo completo sin recorte).

### T4.4 — `CampaignRunner` (`infrastructure/scheduling/CampaignRunner.ts`, molde `ServiceCutRunner.ts` leído completo)
Constructor `(sendCampaign, campaignRepo, lock: DistributedLock)`. `CAMPAIGN_LOCK_KEY = 'messaging-campaign-send'` (molde `SERVICE_CUT_LOCK_KEY`). `start(campaignId)`: valida estado (campaña `done` → lanza `CampaignAlreadyFinishedError` SIN tomar el lock, SEND-1 escenario 2); `lock.tryAcquire` → si no disponible `{accepted:false}` (SEND-1 escenario 1, doble-start concurrente); si sí → marca `running`+`startedAt`, dispara `run()` fire-and-forget, libera el lock en `finally` (igual que `ServiceCutRunner`). **Test primero** (`src/__tests__/infrastructure/CampaignRunner.test.ts`, con `InMemoryDistributedLock` — molde `InMemoryDistributedLock.ts` ya existe): SEND-1 escenario 1 y 2 exactos + verificar que el lock se libera tras `done`/`failed` del run.

---

## Batch 5 — `TwilioContentGateway` (adapter real) — depende de Batch 2, en paralelo con Batch 4

### T5.1 — `TwilioContentGateway` (`infrastructure/adapters/twilio/TwilioContentGateway.ts`)
Patrón axios de `HttpChatwootGateway`/`GestionRealClient` (`axios.create` en ctor, `http` inyectable para tests — design §2.2 opts). `listTemplates()`: `GET /v1/ContentAndApprovals?PageSize=200`, basic auth, **pagina** con `meta.next_page_url` hasta `null`, mapea `approval_requests.status`→`approvalStatus`. `sendTemplate()`: `POST .../Messages.json` form-urlencoded (`MessagingServiceSid`, `To=whatsapp:+E164`, `ContentSid`, `ContentVariables` JSON-string).

### T5.2 — mapeo de errores (clon del razonamiento `isRetryableAxiosError`/`retryAfterMs` de `GestionRealClient.ts`)
Sin `response` (red/timeout) → `TemplateProviderUnavailableError`. `status ∈ {429,500,502,503,504}` → `TemplateProviderUnavailableError` (429 con `retryAfterMs` del header `Retry-After`). 4xx que no sea 429 → `TemplateSendRejectedError`. 401/403 en `listTemplates` → `TemplateProviderUnavailableError` (credencial mala, no per-mensaje).

### T5.3 — tests con HTTP fake inyectable (**NO axios real, NO nock** — mismo criterio TDD del repo: inyectar el `http: AxiosInstance` vía opts con un stub mínimo `{ get: jest.fn(), post: jest.fn() }`)
`src/__tests__/infrastructure/adapters/twilio/TwilioContentGateway.test.ts`:
- `listTemplates`: 1 página → mapea bien; 2 páginas (`meta.next_page_url` no-null luego null) → concatena todo; 401 → `TemplateProviderUnavailableError`.
- `sendTemplate`: 200 → `{providerId, status}`; 429 con header `Retry-After` → `TemplateProviderUnavailableError` con `retryAfterMs` correcto; 400 → `TemplateSendRejectedError`; timeout/`ECONNABORTED` sin `response` → `TemplateProviderUnavailableError`.

---

## Batch 6 — Segmentación (extensión `ListClientsQuery` + `listSegmentRecipients`) + opt-out inbound — depende de Batch 2

### T6.1 — extensión aditiva `ListClientsQuery` (`domain/ports/CustomerRepository.ts`)
Agregar `statuses?: string[]` (precedencia sobre `status` si viene) + `balanceMin?`/`balanceMax?: number`. **Test primero**: `src/__tests__/infrastructure/PrismaCustomerRepository.list.segment.test.ts` — NO puede usar Prisma mockeado (regla del repo); si `PrismaCustomerRepository` no tiene test de integración contra DB real en este repo, seguir el patrón existente en `PrismaCustomerRepository.mappers.test.ts` (leído: valida mapeo puro `toCustomer`/`toActiveClientContact`, no pega contra DB) — extraer la construcción del `where` (T6.2, líneas 184-195) a una función pura testeable `buildClientListWhere(query)` para poder testear la lógica de precedencia `statuses` > `status` SIN Prisma.

### T6.2 — `PrismaCustomerRepository.list` — extensión del `where` (aditiva, `:184-195`)
```ts
if (query.statuses?.length) where['status'] = { in: query.statuses };
else if (query.status) where['status'] = query.status; // path F1 intacto
if (query.balanceMin != null || query.balanceMax != null) {
  where['balanceDue'] = {
    ...(query.balanceMin != null ? { gte: query.balanceMin } : {}),
    ...(query.balanceMax != null ? { lte: query.balanceMax } : {}),
  };
}
```
Riesgo bajo confirmado: `status` solo se toca si llegan `statuses`/`balanceMin`/`balanceMax` — los callers F1 (`ListClients.test.ts`, ya existente, single `status`) deben seguir pasando SIN modificación.

### T6.3 — `listSegmentRecipients(segment)` — método narrow nuevo (molde `listActiveContacts():300`, leído completo)
`CampaignRecipientCandidate { clientId, name, phone, balanceDue, whatsappOptOutAt }`. Prisma `findMany({ where: {status:{in} si statuses.length, balanceDue:{gte,lte}}, select: {...} })` — **sin filtro `whatsappOptOutAt: null` a nivel query** si `statuses` viene vacío (T6.4/OPT-2 necesita poder traer TAMBIÉN los opt-out para otros usos — pero para el bulk normal SÍ filtra `whatsappOptOutAt: null` en el query, doble filtro con el use case por defensa en profundidad, design §4.2). **Aclarar en el código con un comentario**: cuando se llama con `{statuses: []}` sin más filtros, es el escape hatch de matching OPT-2 (T6.5) — devuelve el universo completo para poder resolver un teléfono contra CUALQUIER estado, no solo `active`.
**Test primero** (`src/__tests__/infrastructure/PrismaCustomerRepository.listSegmentRecipients.test.ts` si hay fixture de integración, si no — extraer la construcción de query a función pura testeable, mismo criterio que T6.1).

### T6.4 — `OPT-1`: setear `whatsappOptOutAt` (idempotente, primer-en-ganar)
Nuevo método en `CustomerRepository` (`registerOptOut(clientId): Promise<void>` o similar) + impl Prisma (`update` condicional — solo si `whatsappOptOutAt IS NULL`, vía `updateMany({where:{id, whatsappOptOutAt:null}, data:{whatsappOptOutAt:now()}})`, no pisa `T1`). **Test primero**: cliente sin baja previa → queda seteado; cliente ya opt-out con `T1` → segunda llamada NO cambia el timestamp (comparar antes/después).

### T6.5 — OPT-2: detección BAJA/STOP en `ReceiveChatwootWebhook` (`application/use-cases/messaging/ReceiveChatwootWebhook.ts`, método `handleMessageCreated` ya leído — `:143-180`)
**⚠️ contradicción #4 arriba aplicada acá**: resolver el `Client` por `sender?.phone_number` con `normalizePhone`/`suffixMatch` contra `customerRepo.listSegmentRecipients({statuses:[]})` (NO `listActiveContacts()` — ese excluye a los `late`/`blocked`/`baja` que son justamente el público del bulk). Solo cuando `direction === 'inbound'` y `content.trim().toUpperCase()` (case-insensitive + trim) matchea `'BAJA'` o `'STOP'` exacto (no substring — spec dice "keyword", no "contiene"). Sin match de cliente → no-op (mismo criterio HOOK-4/5 de F1, nunca rompe el resto del webhook).
**Test primero** (`src/__tests__/application/messaging/ReceiveChatwootWebhook.optout.test.ts`, complementa el `ReceiveChatwootWebhook.test.ts` existente sin tocarlo): mensaje `"BAJA"` de contacto matcheado → `whatsappOptOutAt` seteado; `"  stop  "` → igual seteado (case+trim tolerant); `"Hola, tengo un problema..."` → NO modifica; `"BAJA"` de teléfono sin match → procesa sin error (no-op).

---

## Batch 7 — Routes + wiring composition-root — depende de Batch 3/4/5/6

### T7.1 — router `messagingBulk.routes.ts` (`infrastructure/http/routes/messagingBulk.routes.ts`, factory molde `messaging.routes.ts` leído completo — `MessagingRoutePerms` interface, `try/catch → next(err)` en cada handler)
**Prefijo `/api/messaging/bulk` (spec manda, ver contradicción #1)**:
```
GET  /api/messaging/bulk/templates              → ListTemplates          [perms.templates]
POST /api/messaging/bulk/segment/preview         → PreviewCampaignSegment [perms.bulk]
POST /api/messaging/bulk/campaigns               → CreateCampaign         [perms.bulk]
POST /api/messaging/bulk/campaigns/:id/send      → CampaignRunner.start   [perms.bulk]  (202 + campaignId)
GET  /api/messaging/bulk/campaigns/:id           → GetCampaign            [perms.bulk]
GET  /api/messaging/bulk/campaigns               → ListCampaigns          [perms.bulk]
```
`MessagingBulkRoutePerms { bulk: RequestHandler; templates: RequestHandler }`.

### T7.2 — test de rutas (supertest, in-memory repos — molde cualquier `*.routes.test.ts` del repo)
`src/__tests__/infrastructure/messagingBulk.routes.test.ts`: TPL-1 (mixto approved/pending vía HTTP), RBAC-1 (403 sin `messaging.bulk` en preview/create/send/get/list — sin efectos), RBAC-2 (403 con `bulk` pero sin `templates` en `/templates`, y viceversa en `/campaigns`), CAMP-2/3/4 vía HTTP (422 con el `code` correcto), HIST-2 (404 en id inexistente), SEND-1 escenario 2 vía HTTP (`POST .../send` sobre campaña `done` → mapeado por `statusMap.CAMPAIGN_ALREADY_FINISHED`).

### T7.3 — wiring en `app.ts` (composition root — bloque nuevo, cerca del bloque `messaging-inbox (F1)` `:2488-2570` leído completo, DESPUÉS de construir `chatwootGateway`/`customerAdapter`)
```ts
const templatePort = new TwilioContentGateway({
  accountSid: config.twilio.accountSid,
  authToken: config.twilio.authToken,
  messagingServiceSid: config.twilio.messagingServiceSid,
});
const campaignRepo = new PrismaCampaignRepository();
const rateLimiter  = new TokenBucketRateLimiter({ ratePerSec: config.messagingBulk.ratePerSec });
const sendCampaign = new SendCampaign(campaignRepo, customerAdapter, templatePort, rateLimiter);
const campaignRunner = new CampaignRunner(sendCampaign, campaignRepo, new PgAdvisoryLock());
app.use('/api/messaging', createMessagingBulkRouter(
  new ListTemplates(templatePort),
  new PreviewCampaignSegment(customerAdapter),
  new CreateCampaign(campaignRepo, customerAdapter, templatePort), // 3 args — contradicción #2
  campaignRunner,
  new GetCampaign(campaignRepo),
  new ListCampaigns(campaignRepo),
  { bulk: requirePerm('messaging','bulk'), templates: requirePerm('messaging','templates') },
));
```
`requirePerm` (`app.ts:836`), `PgAdvisoryLock` (`../adapters/pg/PgAdvisoryLock`, ya importado `:697`) y `customerAdapter` YA existen — reusar instancias, no duplicar wiring.

### T7.4 — `PrismaCampaignRepository` (`infrastructure/adapters/prisma/PrismaCampaignRepository.ts`)
Implementa `CampaignRepository` contra los modelos de Batch 1. Sin test unitario propio contra DB (no hay DB local, regla CLAUDE.md) — se ejercita indirectamente por T7.2 si las rutas se testean con este repo real (NO — usar `InMemoryCampaignRepository` en T7.2, igual que el resto del repo testea rutas con repos in-memory). Marcar explícitamente: la única verificación real de `PrismaCampaignRepository` es el gate EN VIVO de Batch 9 + `prisma migrate deploy` en CI.

### T7.5 — composition-root pin anti-W6 (test estático)
`src/__tests__/infrastructure/messaging-bulk-composition.test.ts` (molde `messaging-composition.test.ts` ya existente, leído): assert por texto que `app.ts` monta `createMessagingBulkRouter` con las 6 dependencias en orden y los 2 `perms.*` correctos — pin contra "se olvidaron de wirear un endpoint nuevo silenciosamente" (W6).

---

## Batch 8 — Config/secrets (TWILIO_*) — depende de Batch 5, independiente del resto

### T8.1 — `config.ts` (opt-in, patrón `chatwoot` — NO en `REQUIRED_VARS`, boot nunca falla)
```ts
twilio: {
  accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
  authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID ?? '',
},
messagingBulk: {
  ratePerSec: parsePositiveInt(process.env.MESSAGING_BULK_RATE_PER_SEC, { default: 80, max: 1000 }),
},
```
Verificar que `parsePositiveInt` con esa forma `{default,max}` ya existe en `config.ts` (usado en otro lado) antes de asumir la firma — si no existe, escribirlo ahí mismo, pequeño y puro.
**Test**: extender el test de config existente (buscar `config.test.ts` o equivalente) con el caso "TWILIO_* ausente → boot no falla, `config.twilio.accountSid === ''`".

### T8.2 — `.github/workflows/deploy.yml` — 4 líneas nuevas junto al bloque `CHATWOOT_*` (`:108-112`, leído)
```yaml
-e TWILIO_ACCOUNT_SID="${{ secrets.TWILIO_ACCOUNT_SID }}" \
-e TWILIO_AUTH_TOKEN="${{ secrets.TWILIO_AUTH_TOKEN }}" \
-e TWILIO_MESSAGING_SERVICE_SID="${{ secrets.TWILIO_MESSAGING_SERVICE_SID }}" \
-e MESSAGING_BULK_RATE_PER_SEC="${{ secrets.MESSAGING_BULK_RATE_PER_SEC }}" \
```

### T8.3 — checklist explícito de `gh secret set` (lección `ORCHESTRATOR_BASE_URL` — env/config faltante = 502 en prod aunque los tests mockeados pasen)
Antes del deploy, correr (con los valores YA verificados del canal `channel_twilio_sms` de Chatwoot — el BE necesita SUS PROPIOS secrets, no reusa los de Chatwoot en runtime):
```
gh secret set TWILIO_ACCOUNT_SID
gh secret set TWILIO_AUTH_TOKEN
gh secret set TWILIO_MESSAGING_SERVICE_SID
gh secret set MESSAGING_BULK_RATE_PER_SEC   # valor inicial: 80
```
Este paso es MANUAL, no automatizable por `sdd-apply` (requiere el token real) — dejarlo como nota de checklist, no como tarea de código.

---

## Batch 9 — GATE de verificación EN VIVO (bloquea DEPLOY, no bloquea desarrollo)

### T9.1 — test-send real de UN template APROBADO
**Bloqueado hasta que Meta apruebe ≥1 de los 7 templates** (~24-48h desde que se enviaron a aprobación — verificar estado antes de este batch). Objetivo: confirmar en la práctica (design §8, 4 incógnitas):
1. Shape exacto de `ContentVariables` (¿índices `"1"/"2"` o nombres declarados?) — ajusta `TwilioContentGateway.sendTemplate` si hace falta.
2. `toWhatsAppE164` — el prefijo AR-móvil correcto (`+549...`) para que WhatsApp entregue — ajusta T2.5 si el shape real difiere.
3. Límite real de Twilio (~80/s del plan contratado) — calibra `MESSAGING_BULK_RATE_PER_SEC` sin redeploy (T8.1 ya lo deja env-configurable).
4. Callback de respuesta — confirmar que una respuesta al template cae en el inbox F1 (mismo Messaging Service `MG46755c...`) — probar respondiendo desde el celular del usuario tras el test-send.

**Esto es un GATE DE DEPLOY, no de `apply`/`verify`**: todo el código de Batches 1-8 puede completarse y verificarse (tests verdes, RBAC ok, seam completo) SIN este batch. Lo que NO se puede confirmar sin él es que el envío real llega a destino con el shape correcto — marcar la campaña de producción como bloqueada hasta entonces, no el merge del código.

---

## Fuera de scope v1 (explícito, anti scope-creep)

- **Segmentación por NODO** → v2 (el `Client` no tiene fuente de nodo limpia — proposal §3, LOCKED).
- **Delivery receipts vía Twilio status callback** (sent→delivered→read reales) → F3. v1 solo refleja el resultado del ENVÍO (aceptado/fallado por la API).
- **Espejo del outbound del bulk al inbox de Chatwoot** (para que el template disparador se vea en el thread) → F3 (`ChatwootGateway` no tiene `createConversation`, es trabajo de reconciliación aparte, no bloquea el valor de v1 — design §6).
- **UI de gestión de templates** (crear/editar/aprobar desde Prominense) → se gestionan en Meta Business Manager/Twilio Content vía API externa (batch 10 de design, ops-only, NO runtime del BE).
- **Programación de envíos a futuro / recurrencia** → v1 dispara on-demand.

---

## Open flags (requieren decisión de negocio/usuario, no de código)

1. **`variableSpec`/`variablesMap`** — confirmado que es dinámico por-destinatario (ver contradicción #3); si el negocio quería un mapa de valores fijos, avisar ANTES de batch 3.
2. **Tope de tamaño de segmento** — v1 NO implementa ningún máximo de destinatarios por campaña (ni el spec ni el design lo piden como requirement testeable) — riesgo de costo/abuso si alguien crea una campaña de 50k clientes por error. Si se quiere, es un `MAX_SEGMENT_SIZE` + confirmación extra en `CreateCampaign`, no cubierto acá.
3. **Reintento de `failed` en campaña ya `done`** — sin mecanismo hoy (ver contradicción #5). Si el negocio lo necesita, falta un endpoint tipo `POST /campaigns/:id/retry-failed` que resetee status→`running` reusando el mismo executor — no está en el spec actual.
4. **RBAC granularidad `bulk`/`templates`** — implementado separado per design/spec; si `templates` termina gestionándose 100% fuera del BE, podría colapsarse en `bulk` (proposal §RBAC, abierto).
5. **`EMPTY_SEGMENT`** — spec lockea rechazo 422 (CAMP-4); nota del propio spec dice que es "abierto a ajuste" si el negocio prefiere permitir `total:0` como campaña archivable. Implementado como rechazo (lo que dice el MUST), documentado como reversible.

---

## Artefactos
- `openspec/changes/messaging-bulk/tasks.md` (este archivo)
- Engram: `topic_key: "sdd/messaging-bulk/tasks"`, `project: "ipnext-backend"`, `type: "pattern"`
