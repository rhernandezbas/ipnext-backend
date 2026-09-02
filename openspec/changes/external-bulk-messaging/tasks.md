# Tasks — external-bulk-messaging

**Change**: external-bulk-messaging · **Phase**: tasks · **Repo BE**: este worktree
(`.claude\worktrees\external-bulk-messaging-be`). **Repo FE**: `ipnext-frontend`, worktree
`.claude\worktrees\external-bulk-messaging-fe` — Batch B5, DESPUÉS del BE (D13).
**TDD estricto**: RED → GREEN → refactor. Adapters in-memory para use cases (`InMemory*Repository`,
fakes de `TemplateMessagingPort`/`ChatwootGateway`/`FeatureFlagRepository`/`CampaignStarter`), JAMÁS
mockear Prisma ni el use case (lección #28 — seam completo).
**Dependencias entre batches**: B1 (schema+config+ports+adapters+bootstrap) → B2 (`ValidateExternalBulk`,
depende de B1) → B3 (`SendExternalBulk`+`GetExternalBulkCampaign`, depende de B2 — reusa su lógica de
re-validación) → B4a (HTTP bulk + wiring, depende de B1-B3 completos) → B4b (rutas de templates,
depende de B4a) → B5 (FE, depende del contrato de B4a, coordinado no bloqueante). Cada batch cierra con `npm test` + `npx tsc --noEmit` verdes antes de pasar
al siguiente — **no** `npm run build` (regla del repo).
**Matriz spec↔test**: cada task cita el requirement ID (spec.md) que cubre, para que `sdd-verify` arme
la matriz de cobertura 1:1.

---

## Batch 1 — Schema + config + ports + adapters in-memory/Prisma + bootstrap (D1-D3, D10)

> **Nota de apply**: la migración `20261112000000_external_bulk_messaging` y `CampaignRecipient.variables`
> (1.1/1.2, D1.d) quedaron implementadas ANTES de que este archivo reflejara D1.d por escrito — el
> apply-progress de B1 documenta el orden real. Sin desvío de fondo: el resultado coincide con D1.d.

- [x] **1.1** Migración `prisma migrate diff --from-schema-datamodel <schema HEAD> --to-schema-datamodel
  prisma/schema.prisma --script` (sin DB, molde `gr-invoices-sync`): `CREATE TABLE
  "ExternalBulkPreview"` (D1), `CREATE TABLE "ExternalBulkMessagingConfig"` (D1, singleton
  `id='singleton'`), `ALTER TABLE "Campaign" ADD COLUMN "externalIdempotencyKey" TEXT` + `@unique`
  (D1.a, nullable — sin backfill), `ALTER TABLE "CampaignRecipient" ADD COLUMN "variables" JSONB`
  (D1.d, nullable SIN default — aditiva sobre la tabla más grande del dominio: es un ADD COLUMN
  nullable, que en PG11+ NO reescribe la tabla). Al SQL generado APENDAR a mano (sin `BEGIN`/`COMMIT`, D1.c):
  `INSERT INTO "FeatureFlag" ("key","enabled","updatedAt") VALUES
  ('messaging-external-bulk-enabled', false, NOW()) ON CONFLICT DO NOTHING;`. Timestamp posterior al
  último existente en `prisma/migrations/`.
- [x] **1.2** `prisma/schema.prisma`: modelos `ExternalBulkPreview` (con `@@index([expiresAt])`) y
  `ExternalBulkMessagingConfig` tal cual D1; `Campaign.externalIdempotencyKey String? @unique` junto a
  `chatwootLabel`; **`CampaignRecipient.variables Json?`** (D1.d — nullable, SIN default: `null` ≠ `{}`)
  en la MISMA migración de 1.1. `npx prisma generate` limpio. Test: N/A (schema), verificado por
  1.5-1.7 y por B3.
  > **Ámbito B1**: la columna es SOLO persistencia. El merge, el override en el render y todo el
  > camino aditivo `manualContacts → CampaignRecipient` (D4.e, puntos 1-7) son de **B3**.
- [x] **1.3** `domain/errors/external-bulk-messaging.ts` (molde `domain/errors/messaging-bulk.ts`):
  clases tipadas para AUTH-1/2/3, KS-1, VAL-1..10, SEND-1..10, STATUS-1, CONFIG-1..3 — `code` exacto de
  D7.a (`FEATURE_DISABLED`, `CAP_EXCEEDED`, `TEMPLATE_NOT_APPROVED`, `MISSING_TEMPLATE_VARIABLES`,
  `CHATWOOT_LABEL_NOT_FOUND`, `CHATWOOT_UNAVAILABLE`, `PREVIEW_NOT_FOUND`, `PREVIEW_EXPIRED`,
  `PREVIEW_ALREADY_CONSUMED`, `PREVIEW_PAYLOAD_MISMATCH`, `IDEMPOTENCY_KEY_CONFLICT`,
  `CAMPAIGN_RUNNER_BUSY`, `REPORTER_UNAVAILABLE`). Registrar cada `code`→HTTP en el statusMap del
  `errorHandler`. Test: cubierto por B2/B3/B4 (sin test standalone, mismo criterio que
  `MESSAGING_WINDOW_EXPIRED`).
- [x] **1.4** `domain/ports/ExternalBulkPreviewRepository.ts` (NEW): `create`, `findById`,
  `markConsumed(id, campaignId): Promise<boolean>` (D3.b — ganador de la carrera D8),
  `deleteExpiredBefore(date, limit): Promise<number>`. `domain/ports/ExternalBulkMessagingConfigRepository.ts`
  (NEW): `get(): Promise<{maxPerRequest, maxPerDay, updatedAt}>` (defaults 500/2000 si no hay fila,
  CONFIG-1) · `set(patch): Promise<...>`. `domain/ports/CampaignStarter.ts` (NEW, D4.a): interfaz
  estructural `{ start(campaignId: string): Promise<{accepted: boolean}> }` — `CampaignRunner` la
  satisface sin cambios.
- [x] **1.5** RED+GREEN `InMemoryExternalBulkPreviewRepository` + `InMemoryExternalBulkMessagingConfigRepository`
  (NEW, `infrastructure/adapters/in-memory/`): tests de round-trip create/findById; `markConsumed`
  concurrente — 2 llamadas al mismo `id` no-consumido → solo UNA devuelve `true` (D8); config `get()`
  sin fila previa → defaults 500/2000 (CONFIG-1); `set()` persiste y `get()` posterior refleja el
  patch.
- [x] **1.6** RED+GREEN `PrismaExternalBulkPreviewRepository` + `PrismaExternalBulkMessagingConfigRepository`
  (NEW, `infrastructure/adapters/prisma/`, molde `Prisma{Entity}Repository` naming): mismos casos que
  1.5 sobre Prisma; `markConsumed` vía `updateMany({where:{id, consumedAt:null}, data:{consumedAt,
  campaignId}})` → `count===1` (D8 mecanismo exacto); `deleteExpiredBefore` con `limit` acotado (D9).
- [x] **1.7** `domain/ports/CampaignRepository.ts` (`CampaignCreateData`) gana
  `externalIdempotencyKey?: string | null`. Interfaz `CampaignRepository` gana
  `findByExternalIdempotencyKey(key: string): Promise<Campaign | null>` y
  `countSentByCreatorSince(createdById: string, since: Date): Promise<number>` (D3.a — cuenta
  `CampaignRecipient` en `status='sent'`/`sentAt >= since` de campañas del `createdById`, NUNCA lo
  creado, D6). RED+GREEN `InMemoryCampaignRepository` + `PrismaCampaignRepository`: `create` persiste
  `externalIdempotencyKey`; `findByExternalIdempotencyKey` hit/miss; `countSentByCreatorSince` con
  fixtures mixtos (`sent` de ese creador cuenta, `sent` de otro creador NO, `pending`/`failed` NO,
  `sentAt` fuera de rango NO) — paridad InMemory↔Prisma en el MISMO caso (D11).
- [x] **1.8** RED+GREEN `application/use-cases/messaging/externalBulkPayloadHash.ts` (NEW, pura, D5):
  `externalBulkPayloadHash({templateName, variables, chatwootLabel, recipients: {phone, name?,
  variables?}[]})` — orden de recipients y de keys de `variables` (globales Y por-recipient)
  irrelevante (mismo hash); normaliza teléfonos con `normalizePhone`/fallback trim; un dígito
  distinto ⇒ hash distinto; **cambiar el `variables` de UN recipient ⇒ hash DISTINTO** (VAL-10);
  cambiar SOLO el `name` ⇒ MISMO hash (es cosmético, D5); dos entradas del mismo teléfono con
  variables distintas NO colapsan; `chatwootLabel` ausente vs `null` producen el MISMO hash.
- [x] **1.9** `infrastructure/config.ts` (junto a `externalApi`, L511, D10): agrega
  `externalMessaging: { apiKey: process.env.EXTERNAL_MESSAGING_API_KEY ?? '' }` — opt-in, NO en
  `REQUIRED_VARS` (AUTH-3, fail-closed a request-time). `env.example` (junto a `EXTERNAL_API_KEY`,
  L157): agrega `EXTERNAL_MESSAGING_API_KEY=` + comentario "vacío ⇒ 401 fail-closed, key DEDICADA e
  independiente de EXTERNAL_API_KEY (AUTH-2)". Test: N/A (config), cubierto por AUTH-3 en B4.
- [x] **1.10** `infrastructure/bootstrap/bootstrapApiUser.ts` → generalizar a
  `bootstrapMachineUser(userRepo, {login, name, email, passwordHash}): Promise<BootstrapApiUserResult>`
  (D2); `bootstrapApiUser` queda como wrapper delgado (`login:'api'`, backcompat, sus tests actuales
  siguen verdes sin tocar). Nuevo `bootstrapApiMessagingUser` (`login:'api-messaging'`,
  `name:'Api Messaging'`) wrapper análogo. RED+GREEN test (molde `bootstrapApiUser.test.ts`):
  `InMemoryRbacUserRepository`, 1ra corrida → `created`; 2da corrida (mismo login) → `exists`, mismo
  `id`, `passwordHash` no tocado.
- [x] **1.11** `main.ts` (junto a `await bootstrapSystemUsers(...)`, L48): invoca
  `bootstrapApiMessagingUser(userRepo, { passwordHash: bcrypt.hashSync(randomUUID(), 10) })` (D2, hash
  inusable, NO literal en git). Test: cubierto por composition-root en B4 (bootstrap real corre al
  boot de test de `app.ts`, si existe ese fixture) o smoke manual — sin test unitario nuevo dedicado
  (mismo criterio que `bootstrapSystemUsers` actual).
- [x] **Gate B1**: `npx prisma generate` limpio; suites de 1.5-1.8, 1.10 verdes; `npx tsc --noEmit`
  limpio (ports nuevos no rompen implementores existentes). Verificado además con la suite COMPLETA
  del BE (1244 suites / 12828 tests verdes, exit 0) y con las 6 suites nuevas de la scope-addition
  (`variables` en `CampaignRecipient`).

## Batch 2 — `ValidateExternalBulk` (VAL-1..10, KS-1, AUTH-1..3 lógica de use case)

- [x] **2.1** `application/dto/external-bulk-messaging.dto.ts` (NEW): `ValidateExternalBulkInput
  {recipients: {phone: string; name?: string; variables?: Record<string,string>}[]; templateRef?:
  string; templateName?: string; variables?: Record<string,string>; chatwootLabel?: string}` y
  `ValidateExternalBulkOutput` (shape exacto D12/VAL-9: `previewId, expiresAt, renderedMessage`
  (MUESTRA), `counts`, `valid: {phone, name, variables, renderedMessage}[]`,
  `invalid: {input, reason, missingVariables?}[]`, `caps`). El union de `reason` incluye
  `'variables_faltantes'` — reason PROPIA de este change, NO se toca el `ExclusionReason` de
  `messaging-bulk`.
- [x] **2.2** RED — `application/use-cases/messaging/ValidateExternalBulk.ts` (NEW) +
  `__tests__/application/messaging/ValidateExternalBulk.test.ts`, con
  `InMemoryExternalBulkPreviewRepository` + `InMemoryExternalBulkMessagingConfigRepository` +
  `InMemoryCampaignRepository` + fake `TemplateMessagingPort` + fake `ChatwootGateway` + fake
  `FeatureFlagRepository` (constructor real, JAMÁS mock del use case):
  - flag OFF / repo de flags lanza → `FeatureExternalBulkDisabledError` (403), CERO llamadas
    downstream (KS-1, gate 1).
  - forma inválida: `recipients: []`, `recipients` no-array, falta `templateRef`/`templateName` →
    `ValidationError` (400), CERO Chatwoot/DB (VAL-1).
  - `phone:"123"` → `invalid` con `reason` de formato; fijo no-móvil → `reason:'non_mobile'`; 2
    recipients mismo E.164 → 2do `reason:'duplicate'`; recipient con opt-out (match exacto Y por
    sufijo, reuso `matchManualContacts`) → `reason:'opted_out'` (VAL-2).
  - render POR RECIPIENT: dos recipients con `variables` distintas → dos `renderedMessage` distintos;
    el `renderedMessage` de nivel superior es el del PRIMER `valid` (VAL-3).
  - `templateRef`/`templateName` `approvalStatus !== 'approved'` (o inexistente, o ambiguo por
    `friendlyName`, D4.d) → `TemplateNotApprovedError` (422), sin preview (VAL-4).
  - `chatwootLabel` presente y NO en `listAccountLabels()` → `ChatwootLabelNotFoundError` (422);
    gateway lanza → `ChatwootUnavailableError` (503), sin preview, NUNCA se acepta a ciegas (VAL-5).
  - `valid.length > maxPerRequest` → `CapExceededError` con `{limit:'perRequest', maxPerRequest,
    received}` (422), sin preview (VAL-6).
  - `remainingToday` = `maxPerDay - countSentByCreatorSince(apiMessagingUserId, dayStartArt)`;
    `valid.length > remainingToday` → `CapExceededError {limit:'perDay', remainingToday}` (422);
    previews NO consumidos NO descuentan cupo (VAL-7).
  - éxito: persiste `ExternalBulkPreview` con `payloadHash` (usa 1.8) + `expiresAt = +15min` +
    `consumedAt: null`; 2 `validate` idénticos → 2 `previewId` distintos, cada uno con su propio
    `expiresAt` (VAL-8).
  - respuesta 200 con shape completo D12/VAL-9 — `counts` cuadra a mano con un batch mixto
    (2 válidos, 1 duplicado, 1 opt-out, 1 formato inválido) (VAL-9).
- [x] **2.3** GREEN — implementación de `ValidateExternalBulk.ts` siguiendo el orden D0 (flag → zod
  parse → cap por request → template → `matchManualContacts` → label Chatwoot → cupo diario →
  render → persist preview). Recipients sin `name` mapean con `normalizeManualContacts` a
  `{name: phone}` (D4.b, input crudo, no el E.164). `variables` del wire → `{source:'literal', value}`
  por key (D4.c, SOLO literales).
- [x] **2.4** RED+GREEN — merge de variables POR RECIPIENT (VAL-10), en
  `ValidateExternalBulk.test.ts`: `merged = {...variablesGlobales, ...recipient.variables}` (la key
  del recipient GANA, las globales que no pisa SOBREVIVEN); una key declarada por el template que
  falta tras el merge ⇒ ESE recipient cae en `invalid` con `reason:'variables_faltantes'` +
  `missingVariables` ORDENADAS, **200 y el resto del batch sigue `valid`** (NUNCA 422
  `MISSING_TEMPLATE_VARIABLES`); variable EXTRA no declarada ⇒ `valid`, ignorada en el render;
  TODOS inválidos ⇒ 422 `EMPTY_RECIPIENTS` sin persistir preview; el preview persiste el `variables`
  MERGEADO por recipient (no el global crudo) y `payloadHash` cambia si cambia el de UN recipient
  (usa 1.8).
- [x] **2.5** GREEN — `ValidateExternalBulk`: el merge/validación de variables corre DESPUÉS de
  `matchManualContacts` (solo sobre lo que sobrevivió a formato/dedup/opt-out — no se gasta trabajo
  en un número que no se va a usar, y las razones no compiten por el mismo recipient) y ANTES del
  cap por request (`valid` ya descontó los `variables_faltantes`). Las variables declaradas salen de
  `TemplateDto.variables` (keys) — la MISMA fuente que usa `CreateCampaign` en CAMP-3.
- [x] **2.6** RED+GREEN — best-effort purga: cada `validate` exitoso dispara (try/catch, nunca voltea
  el request) `previewRepo.deleteExpiredBefore(now - 24h, 500)` (D9). Test: preview vencido de hace
  >24h desaparece tras un `validate` nuevo; fallo del delete NO rompe la respuesta 200.
- [x] **Gate B2**: `ValidateExternalBulk.test.ts` verde, matriz VAL-1..10 + KS-1 cubierta 1:1; `npx tsc
  --noEmit` limpio.

## Batch 3 — `SendExternalBulk` + `GetExternalBulkCampaign` + variables por-recipient (SEND-1..10, STATUS-1)

- [x] **3.1** `application/dto/external-bulk-messaging.dto.ts`: `SendExternalBulkInput {previewId:
  string}` + header `idempotencyKey: string` pasado aparte (no en el DTO, molde SendTemplateMessage);
  `SendExternalBulkOutput {campaignId, accepted: true, total, resumed?: boolean}`.
- [x] **3.2** RED — `application/use-cases/messaging/SendExternalBulk.ts` (NEW) +
  `__tests__/application/messaging/SendExternalBulk.test.ts`, mismos fakes que B2 + fake
  `CampaignStarter` + `CreateCampaign` real (reuso, sin tocar su spec):
  - falta `previewId` o falta `idempotencyKey` → `ValidationError` (400), sin tocar el preview
    (SEND-1).
  - GUARD-0 (molde `SendTemplateMessage.ts:116`): `idempotencyKey` YA usada por OTRO `previewId` →
    `IdempotencyKeyConflictError` (409), `Campaign` original intacta, CERO nueva `Campaign` (SEND-7).
  - GUARD-0 replay: MISMA key + MISMO `previewId` ya consumido → 200 con la `Campaign` YA creada,
    CERO efectos de creación, CERO segunda `Campaign` (SEND-6).
  - `previewId` inexistente → `PreviewNotFoundError` (404); vencido y no consumido →
    `PreviewExpiredError` (410); consumido por OTRA key → `PreviewAlreadyConsumedError` (409)
    (SEND-2).
  - hash re-calculado desde el preview persistido vs `payloadHash` guardado — mismatch (simulando
    mutación en DB) → `PreviewPayloadMismatchError` (409), sin crear `Campaign` ni consumir (SEND-3).
  - RE-VALIDACIÓN completa: flag pasó a OFF → 403; template pasó a `pending`/`rejected` →
    `TemplateNotApprovedError` 422; cupo diario agotado por OTRA campaña `api-messaging` desde el
    `validate` → `CapExceededError` 422 — NINGUNO crea `Campaign` (SEND-4).
  - recipient opt-out DESPUÉS del `validate` → excluido de la `Campaign` creada, no se le envía
    (SEND-4).
  - éxito: `CreateCampaign.execute({..., manualContacts, chatwootLabel, createdById:
    apiMessagingUserId, externalIdempotencyKey: idempotencyKey})` — recipient sin `name` → `name =
    phone` E.164 (SEND-5, cubre "recipient sin name" y "chatwootLabel propagado").
  - orden `markConsumed` DESPUÉS de `CreateCampaign` (D8): si `markConsumed` devuelve `false` (otro
    ganó la carrera del mismo `previewId`), la `Campaign` recién creada se marca `status:'failed',
    error:'preview consumido por otro request'` y responde 409 `PreviewAlreadyConsumedError`.
  - `runner.start()` → `{accepted:false}` → `CampaignRunnerBusyError` (409) con `{campaignId,
    retryAfterSeconds:60}`; la `Campaign` YA quedó creada/consumida, preview no se puede re-crear
    (SEND-8).
  - retry tras liberarse el lock (mismo key+preview) → 200/202 arrancando/reanudando la MISMA
    `campaignId`, NUNCA una segunda (SEND-8, SEND-6).
  - éxito con runner libre → 202 `{campaignId, accepted:true, total}` (SEND-9).
- [x] **3.3** GREEN — `SendExternalBulk.ts` implementación siguiendo D0 paso a paso (guard-0 →
  flag → preview lookup → hash → re-validación completa → `CreateCampaign` → `markConsumed` →
  `runner.start`). Constructor recibe `CreateCampaign` y `CampaignStarter` inyectados (composition
  root en B4).
- [x] **3.4** RED+GREEN `application/use-cases/messaging/GetExternalBulkCampaign.ts` (NEW) +
  test: campaña con `createdById = api-messaging` → 200 DTO
  `{status, total, sentCount, failedCount, skippedCount, optedOutCount}` (STATUS-1); campaña de la UI
  admin (`createdById` distinto) → `CampaignNotFoundError` (404, no revela existencia, STATUS-1
  scenario "consulta de campaña ajena").
- [x] **3.5** RED+GREEN — camino ADITIVO de `variables` por-recipient, puntos 1-6 de D4.e (SEND-10).
  > **YA HECHO POR B1** (verificado en el worktree, NO rehacer): la columna `CampaignRecipient.variables`
  > + su migración, `CampaignRecipientCreateRow.variables?` (`CampaignRepository.ts:70`), la entidad
  > `CampaignRecipient.variables` (`campaign.ts:138`) y los dos adapters (`InMemoryCampaignRepository`,
  > `PrismaCampaignRepository`) con su test de round-trip. B3 arranca en el punto 1 y CONECTA el resto:
  `ManualContactInput` (`matchManualContacts.ts:6`) `+ variables?: Record<string,string>`;
  `normalizeManualContacts` (`resolveCombinedRecipients.ts:635`) lo PRESERVA tal cual (solo trimea
  `name`/`phone`); `matchManualContacts` (L48-77) lo carga en las resoluciones `linked` y `raw`
  (NO en `excluded` — un excluido no se envía); `CombinedResolvedRecipient` (L67)
  `+ variables?`, poblado solo en la rama csv (`admit()` lo arrastra por spread, sin tocarlo);
  `CreateCampaign` (L152-165) mapea `variables: r.variables ?? null` al
  `CampaignRecipientCreateRow` que B1 ya dejó tipado. Tests: round-trip end-to-end
  `CreateCampaign({manualContacts:[{name,phone,variables}]})` → `CampaignRecipient.variables`
  persistido (InMemory Y Prisma, MISMO caso — paridad D11); contacto SIN `variables` ⇒ `null`
  persistido (no `{}`); un contacto EXCLUIDO (opt-out/teléfono inválido) no persiste nada.
- [x] **3.6** RED+GREEN — **override en `SendCampaign.ts:231`** (D4.e punto 8, SEND-10):
  `const variables = {...resolveCampaignVariables(campaign.variableSpec, candidate),
  ...(recipient.variables ?? {})}`. Tests sobre el use case REAL: (a) el override llega a los TRES
  consumos — `templatePort.sendTemplate` (L244), el `content`/`processedParams` del path Chatwoot
  (L250) y el `renderedBody` proyectado al inbox (L294→L351) — assert en los 3, no solo en el
  primero; (b) el override GANA sobre `source:'name'` de un recipient VINCULADO a un `Client`;
  (c) **NO-REGRESIÓN (obligatoria)**: con `recipient.variables = null` el mapa enviado es IDÉNTICO al
  de `resolveCampaignVariables` — es el test que prueba que no rompimos `messaging-bulk`.
  NO se toca `resolveCampaignVariables` (L540) ni `renderTemplateBody` (L532): siguen puras.
- [x] **3.7** GREEN — `SendExternalBulk`: mapea cada recipient del preview a
  `manualContacts: [{name: name ?? phone, phone, variables: merged}]` y arma el `variableSpec` con
  TODAS las keys que el template declara (`{source:'literal', value: global[k] ?? ''}`, D4.c) para
  no disparar CAMP-3. Test: una key que SOLO aportan los recipients no rompe `CreateCampaign`, y el
  mensaje real que sale lleva el valor del recipient (nunca el `''` del baseline).
- [x] **Gate B3**: `SendExternalBulk.test.ts` + `GetExternalBulkCampaign.test.ts` + la suite de
  `SendCampaign` (incluida la de NO-REGRESIÓN) verdes, matriz SEND-1..10 + STATUS-1 cubierta 1:1;
  `npx tsc --noEmit` limpio.

## Batch 4a — HTTP router bulk + errores + auditoría + config admin + wiring `app.ts` + deploy (AUTH-*, COMP-1, CONFIG-*, AUDIT-1, D7)

- [x] **4.1** RED — `application/use-cases/messaging/GetExternalBulkConfig.ts` +
  `SetExternalBulkConfig.ts` (NEW) + tests: `Get` delega en `configRepo.get()` (defaults si no hay
  fila, CONFIG-1); `Set` rechaza no-entero-positivo y `maxPerRequest > maxPerDay` con
  `ValidationError` (400), config NO se persiste (CONFIG-3); válido → persiste y `get()` posterior
  refleja el patch.
- [x] **4.2** RED — `infrastructure/http/routes/external-messaging.routes.ts` (NEW,
  `createExternalMessagingRouter({validateExternalBulk, sendExternalBulk, getExternalBulkCampaign})`)
  + `__tests__/infrastructure/external-messaging.routes.test.ts` (supertest, use cases REALES +
  repos in-memory, `parseOr400`/`safeParse` NUNCA `.parse()` — D11 "lección obligatoria"):
  - `POST /validate` body basura (JSON malformado, tipos equivocados) → 400 `VALIDATION_ERROR`, NO
    500 (D11 lección).
  - un test por cada `code` de D7.a mapeado a su HTTP: `FEATURE_DISABLED`(403), `CAP_EXCEEDED`(422),
    `TEMPLATE_NOT_APPROVED`/`MISSING_TEMPLATE_VARIABLES`(422), `CHATWOOT_LABEL_NOT_FOUND`(422),
    `CHATWOOT_UNAVAILABLE`(503), `PREVIEW_NOT_FOUND`(404), `PREVIEW_EXPIRED`(410),
    `PREVIEW_ALREADY_CONSUMED`/`PREVIEW_PAYLOAD_MISMATCH`/`IDEMPOTENCY_KEY_CONFLICT`/
    `CAMPAIGN_RUNNER_BUSY`(409, con `Retry-After: 60` header + body `retryAfterSeconds`).
  - `GET /campaigns/:id` — propia (200) vs ajena (404) — reusa 3.4.
  - sin `X-Api-Key` / key incorrecta / key GLOBAL (`config.externalApi.apiKey`) → 401
    `UNAUTHORIZED` en TODAS las rutas del router (AUTH-1/2, aislado a nivel router — el pin real de
    orden va en 4.5).
- [x] **4.3** GREEN — implementación del router: `createApiKeyMiddleware(config.externalMessaging.apiKey)`
  aplicado por el mount (no por-ruta, D7), `express.json({limit:'2mb'})`,
  `createExternalWriteRateLimiter()`. Log estructurado en `SendExternalBulk`
  (`{event:'external-bulk-send', campaignId, previewId, total, idempotencyKey}`, D7.b — AUDIT-1
  "send exitoso audita el campaignId creado", validado sin capturar el log real: assert de que el
  use case no lanza y persiste igual con auditoría genérica). Test AUDIT-1 "validate rechazado
  también audita": `auditMutationsMiddleware` (global, ya cubre todo POST bajo `/api`) — verificar
  con supertest que un `validate` que responde 422 sigue devolviendo 422 sin excepción no controlada
  que rompa el middleware de auditoría (regresión-check, sin código nuevo salvo el log de 4.3).
- [x] **4.4** RED+GREEN `infrastructure/http/routes/externalBulkMessagingConfig.routes.ts` (NEW,
  molde EXACTO `taskStageConfig.routes.ts`) + test: `GET /` gate `messaging:read` (403 sin el
  permiso, CONFIG-2); `PUT /` gate `messaging:manage` (403 con solo `messaging:read`, config no
  cambia, CONFIG-2); `PUT` con `{maxPerRequest:3000, maxPerDay:2000}` → 400, no persiste (CONFIG-3);
  `PUT` válido → 200, `validate`/`send` subsiguientes usan los nuevos topes (integración con B2/B3).
- [x] **4.5** RED — `__tests__/infrastructure/external-bulk-messaging-composition.test.ts` (NEW,
  molde `externalV1-ticket-wiring-composition.test.ts`, bootea `createApp()` real, COMP-1): (a) lee
  el FUENTE de `app.ts` y asserta que el índice del mount de `/api/external/v1/messaging/bulk` es
  MENOR al índice de `app.use('/api/external/v1', createApiKeyMiddleware(), ...)` (L3730); (b)
  supertest: `POST .../messaging/bulk/validate` con la key GLOBAL (`EXTERNAL_API_KEY`) → 401 (AUTH-2,
  probando el orden REAL de montaje, no el middleware aislado); con la key DEDICADA → pasa el auth
  (200/4xx de negocio, nunca 401); (c) `EXTERNAL_MESSAGING_API_KEY` vacía en el proceso → 401 con
  CUALQUIER key, incluso vacía (AUTH-3).
- [x] **4.6** GREEN — `app.ts`: bloque nuevo `app.use('/api/external/v1/messaging/bulk',
  createApiKeyMiddleware(config.externalMessaging.apiKey), createExternalWriteRateLimiter(),
  express.json({limit:'2mb'}), createExternalMessagingRouter({...}))` **inmediatamente ANTES** de la
  línea del mount `/api/external/v1` (L3730, comentario `⚠️ ORDEN LOAD-BEARING`, D7); segundo mount
  `app.use('/api/messaging/config/external-bulk', createExternalBulkMessagingConfigRouter(...))` justo
  después de `/api/messaging/config/task-stages` (L3649, D7.c). Composition root instancia
  `ValidateExternalBulk`/`SendExternalBulk`/`GetExternalBulkCampaign`/`GetExternalBulkConfig`/
  `SetExternalBulkConfig` con los repos Prisma reales + `CampaignRunner` existente como
  `CampaignStarter` + el `rbacUserRepo` para resolver `api-messaging` por login.
- [x] **4.7** `env.example` (completar 1.9 si quedó pendiente) + `.github/workflows/deploy.yml` (junto
  a L119-120): agrega `-e EXTERNAL_MESSAGING_API_KEY="${{ secrets.EXTERNAL_MESSAGING_API_KEY }}" \`.
  Test: N/A (deploy config), verificado manualmente (YAML válido).
- [x] **Gate B4a**: `npm test` completo del BE verde (incluye B1-B4a); `npx tsc --noEmit` limpio. NO
  `npm run build`.

## Batch 4b — Rutas de templates en el router externo (TPL-0..5, AUDIT-2, D4.f, D7.d)

> Depende de B4a (el router y su mount ya existen). CERO use case nuevo: se reusan
> `ListTemplates`/`GetTemplate`/`CreateTemplate`/`SubmitTemplateForApproval` tal cual.

- [x] **4.8** RED — `__tests__/infrastructure/external-messaging-templates.routes.test.ts` (supertest
  sobre el router con los use cases REALES + fake `TemplateAdminPort`/`TemplateMessagingPort`):
  - `GET /templates` → 200 `{data:[…]}` con TODOS los templates (mixto approved/pending),
    `sendable === (approvalStatus==='approved')`, con `variables[]` y `body` (TPL-1).
  - `GET /templates/:sid` → 200 DTO curado; sid desconocido (port lanza `TemplateNotFoundError`) →
    404 `TEMPLATE_NOT_FOUND`; port lanza `TemplateProviderUnavailableError` → 503 (TPL-2).
  - `POST /templates` válido → 201 con `approvalStatus:'unsubmitted'` **y el port de submit NUNCA
    invocado** (spy); `body` vacío/whitespace → 400 `VALIDATION_ERROR`; `category:"PROMO"` → 400;
    tipo equivocado (`friendlyName: 123`) → 400 con mensaje de TIPO, no "es requerido" (D7.d) (TPL-3).
  - `POST /templates/:sid/submit` con `{name:"Promo SETIEMBRE #1", category:"MARKETING"}` → 202
    `{contentSid, submitted:true}` y el port recibió `name:"promo_setiembre_1"`; `name:"###"` → 400;
    `category` inválida → 400; sid desconocido → 404 (TPL-4).
  - **`DELETE /templates/:sid` → 404 y `TemplateAdminPort.deleteTemplate` NO invocado** (spy) (TPL-5).
  - flag OFF → 403 `FEATURE_DISABLED` en las 4 rutas, sin tocar el proveedor; key global → 401; sin
    key → 401 (TPL-0).
- [x] **4.9** GREEN — 4 handlers nuevos en `external-messaging.routes.ts`: gate de flag ANTES de
  llamar al use case, `parseOr400` (zod `safeParse`, NUNCA el casting campo-a-campo de
  `templates.routes.ts:60-72`), `next(err)` para TODO error del port — el `errorHandler` global ya
  mapea `VALIDATION_ERROR`→400, `TEMPLATE_NOT_FOUND`→404, `TEMPLATE_PROVIDER_*`→503 (D7.d, cero
  `code` nuevo). `deleteTemplate` NO se inyecta en las deps del router (D4.f).
- [x] **4.10** GREEN — `app.ts`: el composition root pasa `listTemplates`/`getTemplate`/
  `createTemplate`/`submitTemplate` (las MISMAS instancias que ya usa el router admin) +
  `featureFlags` a `createExternalMessagingRouter`. Test de composition-root (extiende 4.5):
  `GET /api/external/v1/messaging/bulk/templates` con la key GLOBAL → 401 (el orden de mounts
  también protege las rutas nuevas). AUDIT-2: supertest verifica que un `POST /templates` exitoso
  pasa por `auditMutationsMiddleware` sin excepción y que el `GET` no genera mutación.
- [x] **Gate B4b**: suite de templates verde; `npm test` completo del BE verde; `npx tsc --noEmit`
  limpio. NO `npm run build`.

## Batch 5 — FE: card Config → WhatsApp (repo `ipnext-frontend`, worktree
`external-bulk-messaging-fe`, D13, cambio coordinado)

- [x] **5.1** `types/externalBulkMessaging.ts` (NEW): tipos espejo campo-a-campo del DTO D12 —
  `ExternalBulkMessagingConfig {maxPerRequest: number; maxPerDay: number; updatedAt: string}`. Test:
  N/A (tipos), verificado por 5.3.
- [x] **5.2** RED+GREEN `hooks/useExternalBulkMessagingConfig.ts` (molde `useFeatureFlags`, React
  Query): `GET/PUT /api/messaging/config/external-bulk`, desenvuelve el envelope `{data}` (memoria
  `e2e-envelope-mock-mismatch`). Test: hook devuelve `{maxPerRequest, maxPerDay, updatedAt}`
  desenvuelto; `PUT` invalida la query tras éxito.
- [x] **5.3** RED+GREEN `components/settings/ExternalBulkMessagingCard.tsx` (NEW, molde EXACTO
  `ChatwootSendPathCard.tsx`), montada en `pages/whatsapp/WhatsappSettingsPage.tsx` junto a
  `ChatwootSendPathCard`:
  - Bloque 1 — kill-switch: `useFeatureFlags` sobre `messaging-external-bulk-enabled`, toggle +
    confirm SOLO al PRENDER ("Esto habilita envíos masivos de WhatsApp por API sin sesión. Es plata
    real."), apagar sin confirm, gate `admin.flags`.
  - Bloque 2 — 2 inputs numéricos controlados (`maxPerRequest`, `maxPerDay`) + botón "Guardar", gate
    `messaging.manage` (sin el permiso: read-only, NO oculto).
  - 4 estados de fetch: `loading` (skeleton), `error` (banner "estado desconocido", toggle
    DESHABILITADO — jamás mostrar OFF cuando no se sabe), `ready`, `saving` (botón/toggle disabled).
  - Validación cliente (entero ≥ 1, `maxPerRequest <= maxPerDay`) es UX; la autoridad es el 400 del
    BE (CONFIG-3) — test: submit con `maxPerRequest > maxPerDay` deshabilita el botón ANTES de
    llamar al hook; error 400 del BE (mockeado) se muestra igual si el cliente no lo atrapó.
- [x] **5.4** Tests Vitest de accesibilidad: toggle y inputs con `aria-label`/`label` asociado;
  banner de error con rol `alert`; foco visible en el botón "Guardar" tras error.
- [x] **Gate B5**: suite Vitest de `ExternalBulkMessagingCard` + `useExternalBulkMessagingConfig`
  verde; lint/typecheck del FE limpio.

## Batch F (reservado) — Fix wave post-review adversarial

Sin tasks pre-definidas — se completa tras el review adversarial de B1-B5, molde
`chatwoot-hub-sendpath`/`campaign-chatwoot-label` Batch F (severidad ALTO/MEDIO/LOW por finding).

---

## Post-deploy (no-código, runbook del operador/orquestador — D14)

- [ ] **P.1** Deploy DARK: flag `messaging-external-bulk-enabled` sembrado `false` (migración 1.1) +
  `EXTERNAL_MESSAGING_API_KEY` SIN setear → doble apagado (403 flag + 401 key vacía). Mergear tranquilo.
- [ ] **P.2** `gh secret set EXTERNAL_MESSAGING_API_KEY` (32 bytes random) + redeploy — la key existe,
  el flag sigue OFF (403).
- [ ] **P.3** Flip del flag desde la UI (Config → WhatsApp, card de 5.3), sin deploy nuevo.
- [ ] **P.4** Smoke en vivo con 1 número real (el del usuario): `validate` → revisar `renderedMessage`
  y `counts` a ojo → `send` → verificar el WhatsApp recibido, la conversación en Chatwoot y el label
  aplicado.
- [ ] **P.5** Recién con eso verde: fase posterior, skill `whatsapp-bulk-ipnext` (fuera de este
  change — se escribe DESPUÉS de la verificación en vivo).
- [ ] **P.6** Rollback disponible en cualquier punto (orden de rapidez): flag OFF desde la UI
  (instantáneo) → vaciar `EXTERNAL_MESSAGING_API_KEY` + redeploy (401 fail-closed) → revert del
  mount en `app.ts` (4.6). Las 2 tablas y la columna son aditivas/nullable — quedan inertes sin
  migración inversa.

---

## Riesgos / desvíos a vigilar en `sdd-apply` (heredados del design, D15)

- **Orden de mounts en `app.ts` (4.6) es LOAD-BEARING** — si el mount de `/messaging/bulk` cae
  DESPUÉS de L3730, la key global intercepta la ruta y AUTH-2 se rompe solo en runtime (los tests de
  middleware aislado siguen verdes). El test de composition-root (4.5) es el único que lo detecta.
- **`markConsumed` DESPUÉS de `CreateCampaign` (3.2/3.3)** — no invertir el orden: si se consume
  ANTES de crear, un fallo de `CreateCampaign` en el medio deja el preview quemado sin campaña,
  irrecuperable.
- **Cupo diario es eventual, no transaccional (D6)** — el test de B2/B3 no debe asumir atomicidad
  entre `validate` y `send` bajo concurrencia real; el cap por request + el lock global del runner
  son la mitigación aceptada, no una garantía transaccional del cupo.
- **`api-messaging` debe existir ANTES del primer `send`** — si el bootstrap (1.10/1.11) falla
  silenciosamente, `SendExternalBulk` no tiene `createdById` válido; considerar un guard explícito
  (`REPORTER_UNAVAILABLE`, ya tipado en 1.3) si `rbacUserRepo.findByLogin('api-messaging')` devuelve
  `null` en runtime.
