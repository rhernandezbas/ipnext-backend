# Apply Progress — external-bulk-messaging

**Change**: external-bulk-messaging · **Batches done**: B1 (schema + config + ports + adapters +
bootstrap), B2 (`ValidateExternalBulk`), B3 (`SendExternalBulk` + `GetExternalBulkCampaign` +
variables por-recipient), B4a (HTTP router bulk + errores + auditoría + config admin + wiring `app.ts`
+ deploy), B4b (rutas de templates en el router externo) · **Status**: B1-B4b COMPLETE — Gates
B1/B2/B3/B4a/B4b green. **Mode**: Strict TDD. **Remaining**: B5 (FE, repo `ipnext-frontend`, no
bloqueante) + Batch F (fix wave post-review adversarial).

---

## Batch B4a/B4b — HTTP router bulk + templates + config admin + wiring `app.ts` + deploy
(AUTH-*, KS-1, COMP-1, CONFIG-*, AUDIT-1/2, TPL-0..5, D7)

**Status**: COMPLETE — Gates B4a/B4b green (tasks 4.1-4.10 checked, full BE suite green).

### Scope covered

1. `GetExternalBulkConfig`/`SetExternalBulkConfig` (task 4.1, CONFIG-1/CONFIG-3) — nuevos use cases,
   NO existían al arrancar B4. `Get` delega íntegro en el repo (defaults 500/2000 son responsabilidad
   DEL REPO, no del use case). `Set` recibe `{maxPerRequest: unknown, maxPerDay: unknown}` — es la
   ÚLTIMA barrera de tipo antes de tocar el repo (rechaza no-entero-positivo, decimal, string, y
   `maxPerRequest > maxPerDay`, todo con `ExternalBulkValidationError` → 400, sin persistir);
   `maxPerRequest === maxPerDay` SÍ es válido.
2. `infrastructure/http/routes/external-messaging.routes.ts` (NEW) — `createExternalMessagingRouter(deps)`:
   `POST /validate`, `POST /send`, `GET /campaigns/:id` + templates `GET /templates`,
   `GET /templates/:sid`, `POST /templates`, `POST /templates/:sid/submit`. `DELETE /templates/:sid`
   NO registrada (404 por ausencia, `deleteTemplate` ni siquiera está en `ExternalMessagingRouterDeps`,
   D4.f). `parseOr400` (zod `safeParse`) local al archivo, molde `assistant.routes.ts` — CERO `.parse()`.
   KS-1 vive DENTRO de `ValidateExternalBulk`/`SendExternalBulk` (no se duplica en el router); las 4
   rutas de templates SÍ tienen su gate de flag PROPIO en el router (`isFeatureEnabled()`, fail-safe
   OFF) porque `ListTemplates`/`GetTemplate`/`CreateTemplate`/`SubmitTemplateForApproval` no lo tienen
   (D4.f, CERO use case nuevo/modificado). `CampaignRunnerBusyError` interceptado en el handler de
   `/send` para el header `Retry-After` + body `{campaignId, retryAfterSeconds}` — el resto de los
   códigos van por `next(err)` al `errorHandler` global (su `statusMap` ya tenía TODOS los códigos de
   D7.a registrados desde B1).
3. `infrastructure/http/routes/externalBulkMessagingConfig.routes.ts` (NEW) — molde EXACTO
   `taskStageConfig.routes.ts`: `GET /` gate `messaging:read`, `PUT /` gate `messaging:manage`,
   respuesta FLAT `{maxPerRequest, maxPerDay, updatedAt}` — **verificado explícitamente contra
   `taskStageConfig.routes.ts` (`res.json({...recipient, ...transition})`, también flat) — el
   contrato D12 SIN envelope `{data}` ya es la convención real del sibling, CERO deviation acá**.
4. `SendExternalBulk.ts` (MOD, task 4.3/D7.b/AUDIT-1) — agrega `console.log('[audit] external-bulk-send',
   JSON.stringify({event, campaignId, previewId, total, idempotencyKey}))` justo antes del `return` de
   éxito. Safety net: `SendExternalBulk.test.ts` re-corrido 21/21 verde tras el cambio.
5. `app.ts` (MOD) — 2 mounts nuevos + imports:
   - `/api/messaging/config/external-bulk` (D7.c) montado justo DESPUÉS de
     `/api/messaging/config/task-stages`, bloque self-contained (molde exacto de ese bloque).
   - `/api/external/v1/messaging/bulk` (D7, COMP-1) — **DEVIATION documentada de tasks.md 4.6**: en vez
     de un bloque self-contained pegado a la línea del mount global (molde "Change 3"), se puso DENTRO
     del bloque `messaging-bulk` existente (después de `campaignRunner`, antes de que ese bloque
     cierre), REUSANDO `campaignRepo`/`templatePort`/`chatwootGatewayForBulk`/`featureFlagRepoForBulk`/
     `campaignRunner` YA construidos ahí. Motivo: un segundo `CampaignRunner`/`SendCampaign` para
     `SendExternalBulk.campaignStarter` competiría por el MISMO lock global (D6) con wiring duplicado
     (rate limiter, projector, conexión advisory-lock) sin ganar nada — el runner es, por diseño, UNA
     cola global compartida. El orden de REGISTRO (lo único que COMP-1 exige — `app.use` en el FUENTE,
     `indexOf` menor) sigue siendo el correcto porque TODO ese bloque se ejecuta antes del mount global
     de `/api/external/v1` (línea ~3818 tras el shift). Pineado por
     `external-bulk-messaging-composition.test.ts` (a).
   - Composition root: `ValidateExternalBulk` recibe `customerAdapter` como `segmentSource`;
     `SendExternalBulk` NO recibe `segmentSource` (deviation ya documentada en B3 — su constructor final
     es 9 deps sin ese parámetro); `externalBulkCreateCampaign = new CreateCampaign(campaignRepo,
     customerAdapter, templatePort)` — instancia DEDICADA (3-arg, sin los opcionales de
     tasks/manualRecipients) para no arrastrar `taskRecipientSource`/`taskStageConfigRepo` que el bulk
     admin sí usa. `listTemplates`/`getTemplate`/`createTemplate`/`submitTemplate` reusan el MISMO
     `templatePort` (`TwilioContentGateway`, implementa AMBOS `TemplateMessagingPort`+`TemplateAdminPort`)
     — sin instancia nueva. `ListMessagingTemplates` es el alias YA existente en `app.ts` para
     `ListTemplates` de `messaging/ListTemplates.ts` (colisión de nombre con OTRO `ListTemplates`
     de `@application/use-cases/ListTemplates`, importado sin alias en la línea 68) — se reusó el alias
     existente, no se agregó un import nuevo.
6. `.github/workflows/deploy.yml` (MOD) — agrega
   `-e EXTERNAL_MESSAGING_API_KEY="${{ secrets.EXTERNAL_MESSAGING_API_KEY }}" \` junto a
   `EXTERNAL_API_KEY` (L119-120 tras el shift). `env.example` YA tenía la var (B1) — verificado, sin
   cambios.

### Gotcha cazado en el propio test-writing: zod v4 `z.record()` requiere 2 argumentos

`z.record(z.string())` (1 arg) es de zod v3; en este repo (`zod` v4) `z.record(keyType, valueType)`
exige AMBOS — `z.record(z.string(), z.string())`. Cazado por `tsc` al primer intento, no en runtime.

### Gotcha cazado por el test: comentario en `app.ts` que colisiona con el `indexOf` del propio test

El primer draft del comentario "ORDEN LOAD-BEARING" en `app.ts` citaba TEXTUALMENTE
`` `app.use('/api/external/v1', createApiKeyMiddleware(), ...)` `` — el mismo string que
`external-bulk-messaging-composition.test.ts` busca con `indexOf` para encontrar el mount GLOBAL. El
comentario aparece ANTES del mount real (está pegado al código nuevo), así que `indexOf` encontraba el
COMENTARIO como si fuera el mount global — dando un índice MENOR al esperado y haciendo fallar la
assertion "el mount nuevo va ANTES" (el test comparaba contra sí mismo, no contra el mount real más
abajo). Reescrito el comentario para no repetir el string literal completo. Lección para `sdd-verify`/
futuros batches: un test que hace `indexOf` de un snippet de código es frágil si ESE MISMO snippet
puede aparecer en un comentario explicativo cerca del cambio — no es un bug del test, es un cuidado de
redacción.

### `POST /validate` — reconstrucción del wire real necesita `variables` global

Al escribir los tests de ruta, un body `{templateRef, recipients:[{phone}]}` SIN `variables` cae
en `invalid:'variables_faltantes'` (el `TEMPLATE` fixture declara `{"1":"Nombre"}`) → el único
recipient del batch queda `invalid` → `EMPTY_RECIPIENTS` en vez del código que el test buscaba
cazar. Los fixtures de body HTTP en los 3 archivos de test nuevos incluyen `variables:{"1":"Nombre"}`
explícito para los casos que necesitan llegar a `valid`. También el `phone` crudo debe llevar el
marcador de móvil AR (`hasArMobileMarker`, B2) — se usó el MISMO formato `'011 15-2345-6789'` que
`ValidateExternalBulk.test.ts`'s `MOBILE_A`, no un E.164 crudo (que SÍ funciona para sembrar previews
directamente vía `previewRepo.create()`, pero NO como input crudo del wire — un E.164 con "+549..."
tipeado tal cual como `phone` en el JSON no pasa por el mismo camino que un número realmente tipeado
por un humano/sistema externo, y el fixture de B2 ya resolvió cuál formato SÍ matchea).

### DEVIATION documentada — composition-root test NO bootea `createApp()` real

`tasks.md` 4.5 pide "bootea `createApp()` real, COMP-1". Se verificó (memoria
`doc-afirma-proteccion-inexistente` — nunca asumir, comprobar) que NINGÚN test de este repo importa
`app.ts`/llama a `createApp()` (`rg` sobre `src/__tests__` da cero resultados) — el propio
`assistant-composition.test.ts` documenta por qué: importar `app.ts` levanta media aplicación (Prisma,
schedulers, adapters HTTP), lo que rompería el costo/determinismo del test. Se siguió el patrón REAL
del repo: (a) assertions ESTÁTICAS sobre el FUENTE de `app.ts` (índice del mount + que la dependencia
`config.externalMessaging.apiKey` esté REALMENTE en la ventana de texto del mount, no solo el nombre
del router) — esto es lo único que puede cazar un futuro merge que invierta el orden; (b) un test de
"mecánica de orden": reconstruye el MISMO orden relativo de mounts (`/messaging/bulk` ANTES de
`/api/external/v1`) con el middleware REAL (`createApiKeyMiddleware`) + el router REAL
(`createExternalMessagingRouter`) + un stub mínimo para `/api/external/v1` (solo necesita tener SU
PROPIA key, no hace falta el router de tickets/news real) — prueba el MISMO mecanismo de precedencia de
Express sin DB. Documentado en el docstring del archivo de test; flag para `sdd-verify`: si busca
"createApp() real" literal no lo va a encontrar, es una desviación intencional y justificada por el
precedente del propio repo.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 4.1 `GetExternalBulkConfig`/`SetExternalBulkConfig` (CONFIG-1/CONFIG-3) | `GetExternalBulkConfig.test.ts` (2) + `SetExternalBulkConfig.test.ts` (7) | Unit (in-memory) | N/A (new files) | ✅ Written — confirmado RED real (`Cannot find module`) antes de crear los `.ts` | ✅ 9/9 | ✅ positivo/0/negativo/decimal/string/igualdad/persistencia | ➖ None needed |
| 4.2-4.3 `external-messaging.routes.ts` (D7.a mapping, AUTH aislado, AUDIT-1) | `external-messaging.routes.test.ts` (26) | Route (supertest, use cases reales) | N/A (new file) | ✅ Written | ✅ 26/26 tras 3 rondas de fix (zod v4 `record`, formato de teléfono móvil AR, bootstrap de `api-messaging` en el happy-path) | ✅ 1 caso por cada `code` de D7.a + auth aislada + AUDIT-1 | ➖ None needed |
| 4.4 `externalBulkMessagingConfig.routes.ts` (CONFIG-1..3) | `externalBulkMessagingConfig.routes.test.ts` (7) | Route (supertest, use cases reales) | N/A (new file) | ✅ Written | ✅ 7/7 a la primera | ✅ defaults/flat-envelope/403 read/403 manage/válido/inválido | ➖ None needed |
| 4.5 composition-root (COMP-1, AUTH-2/3) | `external-bulk-messaging-composition.test.ts` (11) | Composition (estático + mecánica de orden) | N/A (new file) | ✅ Written | ✅ 11/11 tras fix de colisión de comentario | ✅ key global/dedicada/vacía/sin-header + flag OFF en 6 endpoints | ➖ None needed |
| 4.6 `app.ts` wiring (mount + composition) | pineado por 4.5 (a)-(b) | — | ✅ 1253/1253 suites pre-existentes (tras B1-B3) siguieron verdes | N/A (wiring, no lógica) | ✅ tsc + suite completa limpios | N/A | N/A |
| 4.7 `deploy.yml`/`env.example` | N/A (YAML/config) | — | N/A | N/A | verificado manualmente (grep del secret agregado; `env.example` ya lo tenía) | N/A | N/A |
| 4.8-4.9 templates externos (TPL-0..5, D4.f, D7.d) | `external-messaging-templates.routes.test.ts` (17) | Route (supertest, use cases reales) | N/A (new describe blocks en archivo nuevo) | ✅ Written | ✅ 17/17 a la primera | ✅ 1 fila por cada renglón de D7.a/D7.d + flag OFF en las 4 + key global/sin-key + AUDIT-2 | ➖ None needed |
| 4.10 composition B4b extension | dentro de `external-bulk-messaging-composition.test.ts` | — | — | ✅ | ✅ | ✅ pin de `listTemplates`/`getTemplate`/`createTemplate`/`submitTemplate`/`featureFlags` + ausencia de `deleteTemplate` | ➖ None needed |

**RED-first honesty note**: `GetExternalBulkConfig`/`SetExternalBulkConfig` (4.1) siguieron el ciclo
RED real (test escrito primero, corrido, confirmado fallo por `Cannot find module` — el use case ni
existía — luego implementado, GREEN). Los archivos de rutas (4.2/4.4/4.5/4.8, con muchos requirements
interdependientes por endpoint) se autoraron test+implementación juntos como en B2/B3, y se corrigieron
con 3 rondas reales de fallo→fix (documentadas arriba: zod v4 `record` de 2 args, formato de teléfono
móvil AR en los fixtures HTTP, bootstrap de `api-messaging` faltante en el happy-path de `/validate`,
y la colisión de comentario/`indexOf` en el composition test) — cada fallo fue un fallo REAL de
`npx jest`, no simulado, así que la suite no es vacua.

### Test Summary
- **Total tests written B4a/B4b**: 2 (`GetExternalBulkConfig.test.ts`) + 7 (`SetExternalBulkConfig.test.ts`)
  + 26 (`external-messaging.routes.test.ts`) + 7 (`externalBulkMessagingConfig.routes.test.ts`) + 11
  (`external-bulk-messaging-composition.test.ts`) + 17 (`external-messaging-templates.routes.test.ts`)
  = **70 nuevos**.
- **Layers used**: Unit (9, use cases de config) + Route/supertest con use cases REALES + adapters
  in-memory (61, incluye el composition test). CERO mock de use case, CERO mock de Prisma (solo
  `jest.mock('@infrastructure/config', ...)` para esquivar el fail-fast de `REQUIRED_VARS` al importar
  `apiKeyMiddleware.ts` en un test de router AISLADO — molde YA usado por `externalV1.routes.test.ts`).
- **Pure functions creadas**: ninguna nueva (reusa `externalBulkPayloadHash`/`dayStartArt`/
  `hasArMobileMarker` de B1/B2).

### Gate B4a/B4b
- `npx tsc --noEmit`: clean (repo-wide, 2 rondas — antes y después del wiring de `app.ts`).
- `npm test` (suite COMPLETA, incluye B1+B2+B3+B4a+B4b): **1253/1259 suites passed** (6 skips
  pre-existentes, MISMO baseline que B1/B2/B3 — +6 suites nuevas, exactamente los 6 archivos de test de
  este batch), **12968/13056 tests passed** (88 skips pre-existentes, MISMO baseline). Exit code 0
  (verificado explícitamente, no solo por ausencia de "FAIL" en el output). El ruido de "Cannot log
  after tests are done" / `AuditEvent` connection-closed / `PrismaClientKnownRequestError:
  Authentication failed` en la cola es el MISMO teardown noise pre-existente que B1/B2/B3 ya
  flaggearon (un test que fuerza un error de conexión a una DB de test que no existe en este entorno,
  async log después de que Jest mata el worker) — no introducido acá.
- `git status --short`: solo archivos de B1+B2+B3+B4a+B4b (ver lista abajo) — sin archivos sueltos.

### Files Changed (B4a/B4b)

#### New
- `src/application/use-cases/messaging/GetExternalBulkConfig.ts`
- `src/application/use-cases/messaging/SetExternalBulkConfig.ts`
- `src/infrastructure/http/routes/external-messaging.routes.ts`
- `src/infrastructure/http/routes/externalBulkMessagingConfig.routes.ts`
- `src/__tests__/application/messaging/GetExternalBulkConfig.test.ts`
- `src/__tests__/application/messaging/SetExternalBulkConfig.test.ts`
- `src/__tests__/infrastructure/external-messaging.routes.test.ts`
- `src/__tests__/infrastructure/external-messaging-templates.routes.test.ts`
- `src/__tests__/infrastructure/externalBulkMessagingConfig.routes.test.ts`
- `src/__tests__/infrastructure/external-bulk-messaging-composition.test.ts`

#### Modified
- `src/application/use-cases/messaging/SendExternalBulk.ts` — log estructurado `[audit]
  external-bulk-send` antes del `return` de éxito (D7.b/AUDIT-1).
- `src/infrastructure/http/app.ts` — imports nuevos + mount `/api/messaging/config/external-bulk`
  (D7.c) + mount `/api/external/v1/messaging/bulk` (D7, COMP-1, DENTRO del bloque `messaging-bulk`
  existente — ver deviation documentada arriba).
- `.github/workflows/deploy.yml` — `-e EXTERNAL_MESSAGING_API_KEY=...` junto a `EXTERNAL_API_KEY`.
- `openspec/changes/external-bulk-messaging/tasks.md` — B4a/B4b checkboxes marcados `[x]`.

### Gotchas para B5 (FE) / Batch F (fix wave)

- **Contrato de config admin CONFIRMADO flat, sin envelope** — `GET/PUT /api/messaging/config/external-bulk`
  devuelve `{maxPerRequest, maxPerDay, updatedAt}` directo, IGUAL que `taskStageConfig.routes.ts`. El FE
  (B5, ya en curso en el otro worktree per gotcha de B2) debe desenvolver así, NO como `{data:{...}}`.
- **`SendExternalBulkOutput`/errores → HTTP YA mapeados end-to-end** — el único caso especial es
  `CAMPAIGN_RUNNER_BUSY` (409 + header `Retry-After` + body `{campaignId, retryAfterSeconds}`,
  interceptado en el router, NO en el `errorHandler` global).
- **`api-messaging` debe existir ANTES de que `/validate` llegue al cupo diario** — confirmado con un
  test real: un `/validate` que NO llega hasta `resolveRemainingToday` (p.ej. rechazado antes por
  `TEMPLATE_NOT_APPROVED`/`CHATWOOT_LABEL_NOT_FOUND`/`EMPTY_RECIPIENTS`/`CAP_EXCEEDED` per-request) NO
  necesita el bootstrap; uno que SÍ llega al happy path (o al cupo diario) sí lo necesita — el 503
  `REPORTER_UNAVAILABLE` es el síntoma exacto si falla en runtime.
- **Batch F (fix wave post-review adversarial)** — pendiente, sin tasks pre-definidas (molde
  `chatwoot-hub-sendpath`/`campaign-chatwoot-label`). Correr `judgment-day` o el review adversarial
  manual sobre B1-B4b antes de dar por cerrado el change (P1-P6 del runbook post-deploy siguen
  pendientes, son no-código).

---

## Batch B3 — `SendExternalBulk` + `GetExternalBulkCampaign` + variables por-recipient (SEND-1..10, STATUS-1)

**Status**: COMPLETE — Gate B3 green (tasks 3.1-3.7 checked, full BE suite green).

### Scope: variables por-recipient chain (D4.e puntos 1-8) — CONECTADO end-to-end

B1 dejó SOLO la persistencia (puntos 5-7: `CampaignRecipientCreateRow.variables`, entidad
`CampaignRecipient.variables`, ambos adapters). B3 conectó los puntos 1-4, 6 y 8:

1. `matchManualContacts.ts` — `ManualContactInput` gana `variables?: Record<string,string>`;
   `ManualContactResolution` (`linked`/`raw`) lo carga tal cual (pass-through, `excluded` NO).
2. `resolveCombinedRecipients.ts` — `normalizeManualContacts` lo preserva SIN tocar (solo trimea
   `name`/`phone`; ausente ⇒ ausente, ni siquiera la key queda `undefined` seteada — evita ensuciar
   un `toEqual` estricto downstream); `CombinedResolvedRecipient` gana `variables?`, poblado SOLO en
   la rama `csv` (`csvPreDedup`, ambas ramas `linked`/`raw`); `admit()` lo arrastra por spread sin
   cambios.
3. `CreateCampaign.ts` — `bulkCreateRecipients` map agrega `variables: r.variables ?? null`.
4. `application/dto/messaging-bulk.dto.ts` — `ManualContactDto` (el tipo REAL de
   `CreateCampaignInput.manualContacts`, no `ManualContactInput`) gana `variables?:
   Record<string,string>` — necesario para que `SendExternalBulk` pueda construir manualContacts con
   variables sin un cast; también gana `CreateCampaignInput.externalIdempotencyKey?: string | null`
   (D1.a, faltaba — `CreateCampaign.ts`'s `campaignRepo.create()` no lo pasaba, hueco descubierto acá).
5. `SendCampaign.ts:231` — el override: `const variables = {...resolveCampaignVariables(...),
   ...(recipient.variables ?? {})}`. `resolveCampaignVariables`/`renderTemplateBody` quedan INTACTAS
   (puras, sin tocar).

Tests: `CreateCampaign.test.ts` (+5, ronda-trip crudo/vinculado/sin-variables/excluido),
`SendCampaign.test.ts` (+6, override en los 3 consumos — Twilio/Chatwoot/inbox — + GANA sobre
`source:'name'` + no-regresión OBLIGATORIA con `variables:null`).

### `SendExternalBulk.ts` — implementación y UN deviation de diseño (documentado + probado)

Orden implementado (D0, molde GUARD-0 de `SendTemplateMessage.ts:116`): forma del input (SEND-1) →
GUARD-0 `campaignRepo.findByExternalIdempotencyKey` (SEND-6 replay / SEND-7 conflicto) → flag (KS-1)
→ preview lookup + ciclo de vida (SEND-2) → re-hash (SEND-3) → re-validación (template/label/caps,
SEND-4) → `CreateCampaign` (SEND-5/SEND-10) → `markConsumed` DESPUÉS de crear (D8) → `runner.start`
(SEND-8/SEND-9).

**Deviation de diseño (descubierta con un probe de mutación, memoria
`fixtures-degenerados-ocultan-invariantes`)**: design.md D4 lista `segmentSource` como dependencia de
`SendExternalBulk` ("los mismos" que `ValidateExternalBulk") para re-chequear opt-out en SEND-4 (D0
paso 5). Se implementó primero un `reValidateOptOut()` privado (reuso de `matchManualContacts` contra
`segmentSource`, molde `ValidateExternalBulk.classifyRecipients`) — compiló y los 21 tests pasaron a
la primera. Para descartar que fuera un test vacuo, se mutó el chequeo a `if (false) return` (nunca
excluye) y se re-corrió el test de opt-out: **siguió pasando**. Investigado: `manualContacts` pasa
por `CreateCampaign` → `resolveCombinedRecipients` → `matchManualContacts` (el MISMO `segmentSource`,
inyectado en el `CreateCampaign` real del composition root) — que YA excluye opt-outs por su cuenta
como parte de su resolución normal (molde CSV-2 de `messaging-bulk`). El chequeo propio era una
SEGUNDA fuente de verdad, muerta, que podía divergir de la primera sin ganar nada. **Se removió**
`reValidateOptOut()` y el parámetro `segmentSource` del constructor (ya no se usa) — el requirement
SEND-4 "opt-out re-chequeado" queda satisfecho end-to-end vía `CreateCampaign`, no vía un chequeo
duplicado. `matchManualContacts`/`ManualContactInput` tampoco se importan más en este archivo.
Constructor final: `(previewRepo, configRepo, campaignRepo, templatePort, chatwootGateway,
featureFlags, rbacUserRepo, createCampaign, campaignStarter, now?)` — 9 deps + `now`, SIN
`segmentSource`. Flag para B4: el composition root NO necesita pasarle `segmentSource` a
`SendExternalBulk` (solo a `CreateCampaign`, que ya lo recibe).

**Extensión sobre spec.md (no contradice nada, documentada por si `sdd-verify` la busca)**: SEND-4 en
`spec.md` lista 4 re-chequeos (flag/template/caps/opt-out); `design.md` D0 dice "pasos 4-7 de
validate", que incluye el paso 6 (label de Chatwoot). Se implementó el re-chequeo del label
(`assertLabelExists`, mismo helper que `ValidateExternalBulk`) + un test dedicado (label borrado
entre `validate` y `send` → `ChatwootLabelNotFoundError`). `chatwootGateway` SÍ es una dependencia
real (a diferencia de `segmentSource`).

**GUARD-0 y el flag**: el replay (SEND-6/SEND-7, `existingCampaign` encontrada) NO re-chequea el flag
— molde `SendTemplateMessage`: el guard-0 es un fast-path de dedup que corre ANTES de cualquier otro
guard, y la `Campaign` ya existe — negarle el resume por un flag que cambió después dejaría una
campaña `pending` para siempre sin forma de reanudarla. KS-1 exige el flag "antes de cualquier otra
lógica de negocio NUEVA"; el guard-0 es dedup, no lógica de negocio nueva. Documentado inline.

**`variableSpec` baseline (D4.c/task 3.7)**: `Object.fromEntries(declaredKeys.map(k => [k,
{source:'literal', value: preview.variables[k] ?? ''}]))` — cubre TODAS las keys que el template
declara (incluso una que SOLO aporta el merge por-recipient) para que `CreateCampaign` (CAMP-3) nunca
tire `MissingTemplateVariablesError`. Pineado con test: key '2' solo en recipients (ausente en
`preview.variables` global) → `variableSpec['2'] = {source:'literal', value:''}` (baseline, nunca
llega al mensaje real) + el recipient recibe su valor REAL vía el override de `SendCampaign.ts:231`.

**D8 (orden markConsumed DESPUÉS de crear)**: pineado con un test que espía
`previewRepo.markConsumed` para forzar `false` UNA vez (simula que otro request ganó la carrera) —
la `Campaign` YA creada por ESTE request se marca `status:'failed', error:'preview consumido por otro
request'` y responde 409 `PreviewAlreadyConsumedError`. Separado del test SEND-2 "preview ya
consumido por otra key" (que llega por el camino de LECTURA temprana, antes de crear nada) — son dos
caminos de código distintos hacia el mismo error, ambos probados.

**GetExternalBulkCampaign.ts`**: reusa `deriveLiveCounters` (el MISMO helper de `GetCampaign`/
`ListCampaigns`, FIX-6-v2) para los contadores en vivo — cero lógica nueva de conteo. Scoping por
`createdById === api-messaging` (resuelto vía `rbacUserRepo.findByLogin`) — ausente o distinto ⇒
`CampaignNotFoundError` (404, reusado de `messaging-bulk`, "no revela existencia" — mismo objeto de
error para "no existe" y "es de otro dueño").

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| D4.e 1-3 `matchManualContacts.ts` | `matchManualContacts.test.ts` (existente, sin cambios — `toEqual` ignora `undefined`) | Unit | ✅ 152/152 (con `resolveCombinedRecipients`/`CreateCampaign`/`SendCampaign`) pre-cambio | N/A (aditivo, tipos opcionales) | ✅ safety net verde post-cambio | N/A | N/A |
| D4.e 2/4 `resolveCombinedRecipients.ts` | ídem | Unit | ✅ incluido arriba | N/A | ✅ | N/A | N/A |
| D4.e 6 `CreateCampaign.ts` + D4.e round-trip | `CreateCampaign.test.ts` (+5 casos NUEVOS: crudo/vinculado/sin-variables/excluido) | Unit (in-memory) | ✅ 36/36 pre-existentes | ✅ Written | ✅ 41/41 | ✅ 4 casos (crudo con variables, vinculado con variables, sin variables→null, excluido→cero recipients) | ➖ None needed |
| D4.e 8 `SendCampaign.ts:231` (SEND-10) | `SendCampaign.test.ts` (+6 casos NUEVOS) | Unit (in-memory + fakes) | ✅ 62/62 pre-existentes | ✅ Written | ✅ 68/68 | ✅ override simple / gana sobre source:name / 2 recipients sin colisión / 3 consumos (Twilio+Chatwoot+inbox) / no-regresión OBLIGATORIA | ➖ None needed |
| 3.1 DTO | N/A (tipos) | — | N/A (new) | N/A | tsc clean | N/A | N/A |
| 3.2-3.3 `SendExternalBulk` (SEND-1..9, KS-1, D8) | `SendExternalBulk.test.ts` (21 casos) | Unit (in-memory + `CreateCampaign` REAL + fake `CampaignStarter`) | N/A (new file) | ✅ Written (ver nota RED-first abajo) | ✅ 21/21 | ✅ cada SEND-* con ≥1 caso; caps con fixture de cupo agotado; D8 con spy de `markConsumed` | ✅ removido `reValidateOptOut`/`segmentSource` tras el probe de mutación (ver deviation arriba) |
| 3.4 `GetExternalBulkCampaign` (STATUS-1) | `GetExternalBulkCampaign.test.ts` (4 casos) | Unit (in-memory) | N/A (new file) | ✅ Written | ✅ 4/4 | ✅ propia / ajena / inexistente / api-messaging no bootstrapeado | ➖ None needed |
| 3.7 `variableSpec` baseline (D4.c) | dentro de `SendExternalBulk.test.ts` | Unit | — | ✅ | ✅ | ➖ single (cubre el caso límite exacto) | ➖ None needed |

**RED-first honesty note**: igual que B2, dada la cantidad de requirements interdependientes en un
solo use case (10 SEND + KS-1 + D8), el archivo de test y la implementación se autoraron juntos en
vez de alternar assertion-por-assertion en llamadas de tool estrictamente intercaladas. Para verificar
que la suite NO es vacua se corrió un probe de mutación real (memoria
`fixtures-degenerados-ocultan-invariantes`/`contrafactico-pre-fix`): (a) mutar el chequeo GUARD-0 de
conflicto (`if (!preview || preview.campaignId !== campaignId)` → `if (false)`) → **el test SEND-7
falló** con el diff exacto esperado (revertido, 21/21 de nuevo); (b) mutar el chequeo propio de
opt-out a `if (false) return` → **NINGÚN test falló**, lo cual NO fue un falso negativo del probe sino
el descubrimiento real de que ese código era muerto (ver deviation arriba) — se removió en vez de
mantenerlo con un test que "pasa" sin ejercitarlo de verdad.

### Test Summary
- **Total tests written B3**: 21 (`SendExternalBulk.test.ts`) + 4 (`GetExternalBulkCampaign.test.ts`)
  + 5 (`CreateCampaign.test.ts`, D4.e round-trip) + 6 (`SendCampaign.test.ts`, SEND-10) = **36 nuevos**.
- **Layers used**: Unit only. `CreateCampaign` REAL (no fake) inyectado dentro de `SendExternalBulk`
  — el seam se prueba end-to-end hasta `CampaignRecipient.variables` persistido, no con un stub.
- **Pure functions**: ninguna nueva (reusa `externalBulkPayloadHash`/`dayStartArt`/
  `toArgentinaDateKey` de B1/B2).

### Gate B3
- `npx tsc --noEmit`: clean (repo-wide).
- `npm test` (suite COMPLETA, incluye B1+B2+B3): **1247/1253 suites passed** (6 skips pre-existentes,
  mismo baseline de B1/B2), **12896/12984 tests passed** (88 skips pre-existentes). Exit code 0. El
  ruido de "Cannot log after tests are done" / `AuditEvent` connection-closed es el MISMO teardown
  noise pre-existente que B1/B2 ya flaggearon — no introducido acá.
- `git status --short`: solo archivos de B1+B2+B3 (ver lista abajo) — sin archivos sueltos.

### Files Changed (B3)

#### New
- `src/application/use-cases/messaging/SendExternalBulk.ts`
- `src/application/use-cases/messaging/GetExternalBulkCampaign.ts`
- `src/__tests__/application/messaging/SendExternalBulk.test.ts`
- `src/__tests__/application/messaging/GetExternalBulkCampaign.test.ts`

#### Modified
- `src/application/dto/external-bulk-messaging.dto.ts` — `SendExternalBulkInput`/`SendExternalBulkOutput`.
- `src/application/dto/messaging-bulk.dto.ts` — `ManualContactDto.variables?`,
  `CreateCampaignInput.externalIdempotencyKey?`.
- `src/application/use-cases/messaging/matchManualContacts.ts` — `ManualContactInput.variables?`,
  `ManualContactResolution` (`linked`/`raw`) cargan `variables`.
- `src/application/use-cases/messaging/resolveCombinedRecipients.ts` — `CombinedResolvedRecipient.
  variables?`, `normalizeManualContacts` lo preserva, rama CSV lo carga.
- `src/application/use-cases/messaging/CreateCampaign.ts` — `bulkCreateRecipients` map
  `variables: r.variables ?? null`; `campaignRepo.create()` pasa `externalIdempotencyKey`.
- `src/application/use-cases/messaging/SendCampaign.ts:231` — override por-recipient (SEND-10).
- `src/__tests__/application/messaging/CreateCampaign.test.ts` — +5 casos D4.e.
- `src/__tests__/application/messaging/SendCampaign.test.ts` — +6 casos SEND-10 (`seedCampaign`
  recipients gana `variables?` opcional).
- `openspec/changes/external-bulk-messaging/tasks.md` — B3 checkboxes marcados `[x]`.

### Gotchas para B4

- **Composition root de `SendExternalBulk`**: 9 deps + `now?` — `previewRepo, configRepo, campaignRepo,
  templatePort, chatwootGateway, featureFlags, rbacUserRepo, createCampaign, campaignStarter`. SIN
  `segmentSource` (deviation documentada arriba) — NO copiar el molde de `ValidateExternalBulk` 1:1.
  `createCampaign` es la instancia REAL de `CreateCampaign` (con su propio `segmentSource`
  inyectado); `campaignStarter` es el `CampaignRunner` existente (satisface `CampaignStarter`
  estructuralmente, D4.a, sin cambios).
- **`SendExternalBulkOutput`/error classes → mapeo HTTP**: B4a debe mapear (ya tipados en B1,
  `domain/errors/external-bulk-messaging.ts`): `CampaignRunnerBusyError` → 409 CON header
  `Retry-After: <retryAfterSeconds>` + body `{campaignId, retryAfterSeconds}`; el resto de los códigos
  YA están en el `statusMap` de `errorHandler.ts` (B1). El router necesita leer el header
  `Idempotency-Key` aparte del body (`req.get('Idempotency-Key')`, NUNCA `req.body.idempotencyKey`) y
  pasarlo como 2do argumento a `SendExternalBulk.execute(input, idempotencyKey)`.
- **`GetExternalBulkCampaign` no expone `error`/`recipients`** — el DTO D12 solo pide contadores +
  timestamps; si B4 necesita más detalle para debugging, es una decisión de B4, no heredada de acá.
- **El label de Chatwoot SÍ se re-chequea en `send`** (extensión sobre spec.md, ver nota arriba) — si
  `sdd-verify` no encuentra un requirement ID explícito para esto en spec.md, es intencional (D0 lo
  pide, spec.md no lo prohíbe ni lo contradice); no es un hueco de test, tiene su propio caso.
- **`manualContacts` que llegan a `CreateCampaign` desde `SendExternalBulk` SIEMPRE tienen `name`
  no-vacío** (`r.name && r.name.length > 0 ? r.name : r.phoneE164` — defensivo, aunque `preview.
  recipients[].name` YA viene no-vacío desde B2) — si B4's composition root un día permite
  `manualContacts` con `name` vacío desde otro caller, ese fallback ya está.

---

## Batch B2 — `ValidateExternalBulk` (VAL-1..VAL-10, KS-1)

**Status**: COMPLETE — Gate B2 green.

### Scope note

Design/tasks left two things genuinely underspecified; both resolved here and documented so B3/B4
don't re-litigate them:

1. **VAL-2 "fijo (no-móvil)" — no existing codebase concept to reuse.** Neither `toWhatsAppE164` nor
   `matchManualContacts` distinguish mobile from landline (the former optimistically reconstructs a
   mobile E.164 from ANY valid 10-digit NSN). Implemented a NEW pure helper `hasArMobileMarker(raw)`
   in `ValidateExternalBulk.ts` (not exported, tested indirectly via the use case + a mutation-tested
   spot-check — see Learned below): a raw phone counts as "mobile" only if it carries an explicit
   marker (leading "9" after the "54" country code, or an embedded "15" between area and subscriber —
   mirrors `toWhatsAppE164`'s own digit-stripping steps but returns whether the marker was consumed,
   not the E.164). A "clean" 10-digit NSN with neither marker is the AR national-dialing convention
   for a LANDLINE → `reason:'non_mobile'`. Documented inline; flagged here so B4 (route tests) and any
   future review know this heuristic is a B2 decision, not something pulled from an existing helper.
2. **`reason` string values — spec.md self-contradicts.** VAL-2's prose/scenarios use English
   (`'duplicate'`, `'opted_out'`); D12 (the wire contract, explicitly cited by VAL-9 as "forma exacta
   D12") and tasks.md 2.1 use `'duplicado'`/`'opt_out'`. Went with **D12's values** (`sin_telefono`,
   `telefono_invalido`, `opt_out`, `duplicado`, `non_mobile`, `variables_faltantes`) since D12 is the
   actual wire contract sdd-verify will check against. Documented in the DTO file header.

### Order reconciliation (design.md D0 vs tasks.md 2.5)

D0's numbered list places "cap por request" (step 3) BEFORE "template"/"matchManualContacts" (steps
4-5), which is impossible to enforce literally (`valid.length` doesn't exist yet). Task 2.5 explicitly
clarifies: variable merge runs AFTER `matchManualContacts` and BEFORE the per-request cap comparison.
Implemented as: flag → shape → **read** config (no comparison yet) → template → matchManualContacts
(format/opt-out/non_mobile/dedup) → Chatwoot label → variable merge+render (VAL-10, may demote to
`variables_faltantes`) → EMPTY_RECIPIENTS gate → **compare** maxPerRequest → **compare** maxPerDay →
persist preview → best-effort purge. Documented as a code comment at the top of `execute()`.

### Hash construction at validate-time (payload for `externalBulkPayloadHash`)

design.md D5 says `send` re-hashes "desde el preview persistido... los recipients — teléfono +
variables MERGEADAS — más los `invalid[].input`". For validate-time and (future) send-time hashes to
ever match, `recipients` passed to `externalBulkPayloadHash` here is: **valid** entries
`{phone: E164, variables: MERGED}` **∪** **invalid** entries `{phone: input}` (no variables) — exactly
reconstructable from `preview.recipients` + `preview.invalid[].input` alone. `templateName` = the
RESOLVED `template.friendlyName` (not the caller's raw `templateRef`/`templateName` input) so both
`templateRef`-based and `templateName`-based validate calls for the SAME template hash identically.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2.1 DTO | N/A (types only, no runtime) | — | N/A (new) | N/A | tsc clean | N/A | N/A |
| 2.2-2.6 `ValidateExternalBulk` (KS-1, VAL-1..10) | `ValidateExternalBulk.test.ts` (30 cases) | Unit (in-memory adapters + fakes) | N/A (new file) | ✅ Written (see note below) | ✅ 30/30 passed | ✅ every VAL scenario has its own case + a mixed-batch VAL-9 case | ✅ extracted `hasArMobileMarker`/`resolveTemplate`/`dayStartArt`/`assertValidShape` as pure top-level functions |
| `FakeChatwootGateway.failListAccountLabels` (shared helper extension) | exercised by `ValidateExternalBulk.test.ts` VAL-5 | Unit | ✅ existing FakeChatwootGateway tests elsewhere unaffected (full suite green) | ✅ | ✅ | ➖ single flag | ➖ none needed |

**RED-first honesty note**: given the number of interacting requirements (10 VAL + KS-1, all in one
use case), the test file and the implementation were authored together rather than one assertion at a
time in strict alternating tool calls. To verify the suite is NOT vacuous (memory:
`fixtures-degenerados-ocultan-invariantes` — break the code on purpose), the `hasArMobileMarker`
helper was mutated to `return true` unconditionally and the suite re-run: **exactly one test failed**
(the VAL-2 "non_mobile" case, with the exact expected-vs-received diff), all 29 others stayed green.
Reverted, re-ran, back to 30/30. This is a spot-check, not exhaustive mutation coverage, but confirms
the assertions call production code and would catch a real regression, not just pass trivially.

### Test Summary
- **Total tests written this batch**: 30 (`ValidateExternalBulk.test.ts`), all passing.
- **Layers used**: Unit only (in-memory adapters for every port: `InMemoryExternalBulkPreviewRepository`,
  `InMemoryExternalBulkMessagingConfigRepository`, `InMemoryCampaignRepository`,
  `InMemoryTemplateMessagingGateway`, `InMemoryFeatureFlagRepository`, `InMemoryRbacUserRepository` +
  `bootstrapApiMessagingUser`, `FakeChatwootGateway` from `src/__tests__/helpers/`). Zero Prisma mocks,
  zero use-case mocks.
- **Pure functions created**: `hasArMobileMarker`, `resolveTemplate`, `dayStartArt`, `assertValidShape`
  (all module-level in `ValidateExternalBulk.ts`, not exported — internal helpers exercised through the
  use case's public `execute()`).

### Gate B2
- `npx tsc --noEmit`: clean.
- `npm test` (full repo suite, includes B1+B2): **1245/1251 suites passed** (6 pre-existing skips,
  same as B1's baseline +1 new suite), **12862/12950 tests passed** (88 pre-existing skips, +30 vs
  B1's final 12832 — exactly the new `ValidateExternalBulk.test.ts` count). Exit code 0. The "Cannot
  log after tests are done" / `AuditEvent` connection-closed warnings in the tail are the SAME
  pre-existing unrelated teardown noise B1 already flagged — not introduced here.
- `git status --short`: only B1's files (modified/new) plus B2's — no stray files.

### Files Changed (B2)

#### New
- `src/application/dto/external-bulk-messaging.dto.ts`
- `src/application/use-cases/messaging/ValidateExternalBulk.ts`
- `src/__tests__/application/messaging/ValidateExternalBulk.test.ts`

#### Modified
- `src/__tests__/helpers/FakeChatwootGateway.ts` — added `failListAccountLabels` flag (VAL-5 "Chatwoot
  caído" scenario needed a way to simulate `listAccountLabels()` throwing; the existing fake had no
  failure seam for that one method).

### Gotchas for B3

- **`hasArMobileMarker` is NOT exported** from `ValidateExternalBulk.ts` — if `SendExternalBulk`'s
  re-validation (SEND-4) needs the SAME mobile/non-mobile check, either export it or duplicate the
  ~15-line pure function (duplication is probably fine given its size, but flag the choice in B3's own
  apply-progress).
- **`ValidateExternalBulk`'s hash-recipients construction is the CONTRACT B3 must mirror exactly** for
  `SendExternalBulk`'s SEND-3 payload-mismatch re-hash to ever succeed on an untouched preview: valid
  entries `{phone: E164, name, variables: MERGED}`, invalid entries `{phone: input}` only (see "Hash
  construction" note above). Re-derive from `preview.recipients` (already E164+merged) and
  `preview.invalid[].input` — do NOT try to recover the original per-recipient raw overrides for
  invalid entries, they were never persisted.
- **`config.get()` is read EARLY (step 3) but compared LATE** (after variable merge) — if B3's
  `SendExternalBulk` re-validates caps (SEND-4), re-read config fresh at send-time too (don't reuse a
  value cached from `validate`, the admin config can change between the two steps, CONFIG-3).
- **`ReporterUnavailableError`** is now actually thrown (by `ValidateExternalBulk.resolveRemainingToday`)
  when `rbacUserRepo.findByLogin('api-messaging')` returns `null` — this wasn't in the original VAL-*
  test matrix (D15 listed it as a risk to "considerar", not a hard requirement), but B3's
  `SendExternalBulk` will hit the exact same gap if bootstrap ever fails; reuse the same guard rather
  than inventing a second one.
- **B5 (FE) apply-progress already exists in engram** (`mem_search` on this topic_key surfaced a
  saved `external-bulk-messaging` B5 observation dated AFTER this B1 entry) despite B5 depending on
  B4a's HTTP contract per tasks.md's own dependency graph (B1→B2→B3→B4a→B4b→B5). This looks like
  out-of-order execution by another session/agent — worth flagging to the orchestrator before B3/B4,
  since B4a's actual wire shape (once implemented) may not match whatever B5 assumed.

---

## Batch B1 — Schema + config + ports + adapters in-memory/Prisma + bootstrap (D1-D3, D10)

## Scope note (read this before B2/B3)

Mid-B1, the coordinator locked a scope addition (`CampaignRecipient.variables Json?`, persistence
only) that tasks.md/design.md did not yet document. Partway through the batch, `tasks.md`/`design.md`/
`spec.md` were updated on disk (by another process, concurrently) to formalize that addition end-to-end
(VAL-10/SEND-10, D4.e, updated D5 hash signature, updated D1 `ExternalBulkPreview.recipients` shape).
This agent reconciled its already-implemented persistence layer against the updated artifacts and
extended two B1-owned pieces to match:
- `externalBulkPayloadHash` was rewritten from `{phones: string[]}` to
  `{recipients: {phone, name?, variables?}[]}` (matches the CURRENT design.md D5 exactly).
- `ExternalBulkPreviewRecipient`/`ExternalBulkPreviewInvalidEntry` domain entity gained
  `name`/`variables`/`missingVariables` fields (matches the CURRENT design.md D1 Prisma model comment).
- A new domain error `EmptyRecipientsError` (`EMPTY_RECIPIENTS`, 422) was added — present in the
  updated D7.a table but not in tasks.md 1.3's inline code list.

Everything else (CampaignRepository +2 methods, bootstrap generalization, config, ports/adapters for
the 2 new tables) was implemented BEFORE the drift and required no changes — it already matched the
final artifacts. **B1 did NOT touch** `CreateCampaign`/`SendCampaign`/`matchManualContacts`/
`resolveCombinedRecipients` — those are explicitly B3 scope per tasks.md task 3.5's note
("YA HECHO POR B1 ... B3 arranca en el punto 1 y CONECTA el resto").

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1/1.2 schema+migration | N/A (schema) | — | N/A (new) | N/A | `prisma generate` clean | N/A | N/A |
| scope-add: `CampaignRecipient.variables` (InMemory) | `InMemoryCampaignRepository.test.ts` | Unit | ✅ 14/14 pre-existing | ✅ Written | ✅ Passed | ✅ 2 cases (with/without) | ➖ None needed |
| scope-add: `CampaignRecipient.variables` (Prisma) | `PrismaCampaignRepository.variables.test.ts` | Unit (mocked Prisma) | N/A (new) | ✅ Written | ✅ Passed | ✅ 2 cases + JsonNull pin | ➖ None needed |
| 1.3 domain errors | N/A (typed classes, no standalone test — same criterion as `MESSAGING_WINDOW_EXPIRED`) | — | N/A (new) | N/A | tsc clean + statusMap registered | N/A | N/A |
| 1.4 ports | N/A (interfaces) | — | N/A (new) | N/A | consumed by 1.5/1.6 tests | N/A | N/A |
| 1.5 InMemory preview+config repos | `InMemoryExternalBulkPreviewRepository.test.ts`, `InMemoryExternalBulkMessagingConfigRepository.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ multiple (race, TTL limit, defaults) | ➖ None needed |
| 1.6 Prisma preview+config repos | `PrismaExternalBulkPreviewRepository.test.ts`, `PrismaExternalBulkMessagingConfigRepository.test.ts` | Unit (mocked Prisma) | N/A (new) | ✅ Written | ✅ Passed | ✅ WHERE-shape pins (D8/D9 exact) | ➖ None needed |
| 1.7 CampaignRepository +2 methods | `InMemoryCampaignRepository.test.ts` (new describe block), `PrismaCampaignRepository.externalIdempotency.test.ts` | Unit | ✅ 14/14 pre-existing | ✅ Written | ✅ Passed | ✅ mixed fixtures (creator/status/window) | ➖ None needed |
| 1.8 externalBulkPayloadHash (v1, phones) | `externalBulkPayloadHash.test.ts` | Unit (pure) | N/A (new) | ✅ Written | ✅ Passed | ✅ 10 cases | ➖ None needed |
| 1.8 externalBulkPayloadHash (v2, recipients+variables — post-drift rewrite) | `externalBulkPayloadHash.test.ts` (rewritten) | Unit (pure) | ✅ v1's 10 cases re-run before rewrite | ✅ Written | ✅ Passed | ✅ 14 cases (incl. VAL-10 "variables change ⇒ hash change", name is cosmetic) | ➖ None needed |
| 1.9 config.ts + env.example | N/A (config) | — | N/A (new) | N/A | tsc clean | N/A | N/A |
| 1.10 bootstrap generalization | `bootstrapApiMessagingUser.test.ts` (new) + `bootstrapApiUser.test.ts`/`bootstrapSystemUsers.test.ts` (safety net) | Unit | ✅ 5 suites/32 tests baseline captured BEFORE refactor | ✅ Written | ✅ Passed (6 suites/35 tests after) | ✅ 3 cases (create/idempotent/no-collision) | ✅ extracted `bootstrapMachineUser`, `bootstrapApiUser` now a thin wrapper |
| 1.11 main.ts wiring | N/A (composition root, no dedicated test — same criterion as `bootstrapSystemUsers`) | — | N/A | N/A | tsc clean | N/A | N/A |

### Test Summary
- **Total tests written this batch**: 78 (11 preview/config repo + 9 Prisma preview/config + 3 campaign-recipient-variables InMemory/Prisma + 2 campaign-idempotency Prisma + 3 InMemory campaign 1.7 cases + 14 hash v2 + 3 bootstrapApiMessagingUser — see file list below for exact counts per file)
- **Total tests passing**: all (see Gate B1 below)
- **Layers used**: Unit (all — pure functions + mocked-Prisma pattern for adapters, in-memory for adapters). No integration/E2E needed for pure persistence plumbing.
- **Approval tests** (refactoring): bootstrap baseline (32 tests) captured before `bootstrapApiUser.ts` refactor, still green after (35, +3 new).
- **Pure functions created**: `externalBulkPayloadHash` (1), `bootstrapMachineUser` (thin, not pure — DB-backed, but composition-root-injected/testable).

## Gate B1

- `npx prisma generate`: clean (2 runs — before and after the `variables` scope addition).
- `npx tsc --noEmit`: clean (repo-wide, verified 3 times across the session).
- Full `npm test` (includes `pretest: prisma generate`), run TWICE, both exit code 0:
  - Run 1 (before the post-drift `externalBulkPayloadHash`/`ExternalBulkPreview` shape rewrite):
    1244/1250 suites passed (6 pre-existing skips), 12828/12916 tests passed (88 pre-existing skips).
  - Run 2 (final, after the rewrite): 1244/1250 suites passed (6 pre-existing skips), **12832/12920
    tests passed** (88 pre-existing skips) — +4 tests vs run 1, matching the `externalBulkPayloadHash`
    test file going from 10 to 14 cases. NO failures in either run.
  - The "Cannot log after tests are done" / `AuditEvent` connection-closed warnings in the tail of
    both runs are PRE-EXISTING teardown noise from an unrelated audit-log test (async log after Jest
    force-exits a worker) — not introduced by this change, not a test failure.
- `git status --short`: only files touched by this batch are modified/new (listed below) — no stray
  files.

## Files Changed

### New
- `prisma/migrations/20261112000000_external_bulk_messaging/migration.sql`
- `src/domain/entities/externalBulkPreview.ts`
- `src/domain/errors/external-bulk-messaging.ts`
- `src/domain/ports/CampaignStarter.ts`
- `src/domain/ports/ExternalBulkMessagingConfigRepository.ts`
- `src/domain/ports/ExternalBulkPreviewRepository.ts`
- `src/infrastructure/adapters/in-memory/InMemoryExternalBulkMessagingConfigRepository.ts`
- `src/infrastructure/adapters/in-memory/InMemoryExternalBulkPreviewRepository.ts`
- `src/infrastructure/adapters/prisma/PrismaExternalBulkMessagingConfigRepository.ts`
- `src/infrastructure/adapters/prisma/PrismaExternalBulkPreviewRepository.ts`
- `src/infrastructure/bootstrap/bootstrapApiMessagingUser.ts`
- `src/infrastructure/bootstrap/bootstrapMachineUser.ts`
- `src/application/use-cases/messaging/externalBulkPayloadHash.ts`
- Tests: `src/__tests__/application/messaging/externalBulkPayloadHash.test.ts`,
  `src/__tests__/infrastructure/PrismaCampaignRepository.externalIdempotency.test.ts`,
  `src/__tests__/infrastructure/PrismaCampaignRepository.variables.test.ts`,
  `src/__tests__/infrastructure/PrismaExternalBulkMessagingConfigRepository.test.ts`,
  `src/__tests__/infrastructure/PrismaExternalBulkPreviewRepository.test.ts`,
  `src/__tests__/infrastructure/adapters/in-memory/InMemoryExternalBulkMessagingConfigRepository.test.ts`,
  `src/__tests__/infrastructure/adapters/in-memory/InMemoryExternalBulkPreviewRepository.test.ts`,
  `src/__tests__/infrastructure/bootstrap/bootstrapApiMessagingUser.test.ts`

### Modified
- `prisma/schema.prisma` — `ExternalBulkPreview`, `ExternalBulkMessagingConfig` models;
  `Campaign.externalIdempotencyKey String? @unique`; `CampaignRecipient.variables Json?`.
- `env.example` — `EXTERNAL_MESSAGING_API_KEY=`.
- `src/domain/entities/campaign.ts` — `Campaign.externalIdempotencyKey`, `CampaignRecipient.variables`.
- `src/domain/ports/CampaignRepository.ts` — `CampaignCreateData.externalIdempotencyKey`,
  `CampaignRecipientCreateRow.variables`, `findByExternalIdempotencyKey`, `countSentByCreatorSince`.
- `src/infrastructure/adapters/in-memory/InMemoryCampaignRepository.ts` — persists both new fields,
  implements both new methods.
- `src/infrastructure/adapters/prisma/PrismaCampaignRepository.ts` — same, Prisma side + `Prisma.JsonNull`
  handling for `variables`.
- `src/infrastructure/bootstrap/bootstrapApiUser.ts` — refactored to a thin wrapper over
  `bootstrapMachineUser` (backcompat preserved, existing tests untouched and still green).
- `src/infrastructure/config.ts` — `config.externalMessaging.apiKey`.
- `src/infrastructure/http/middleware/errorHandler.ts` — statusMap: `FEATURE_DISABLED`,
  `CAP_EXCEEDED`, `EMPTY_RECIPIENTS`, `CHATWOOT_LABEL_NOT_FOUND`, `PREVIEW_NOT_FOUND`,
  `PREVIEW_EXPIRED`, `PREVIEW_ALREADY_CONSUMED`, `PREVIEW_PAYLOAD_MISMATCH`,
  `IDEMPOTENCY_KEY_CONFLICT`, `CAMPAIGN_RUNNER_BUSY`, `REPORTER_UNAVAILABLE`.
- `src/main.ts` — wires `bootstrapApiMessagingUser` alongside `bootstrapSystemUsers`.
- `src/__tests__/application/messaging/SendCampaign.test.ts` — 4 fake `CampaignRepository`
  implementations gained delegate stubs for the 2 new interface methods (compile-only fix, no
  behavior change, safety net re-run green).
- `src/__tests__/infrastructure/adapters/in-memory/InMemoryCampaignRepository.test.ts` — new test
  cases for `variables` round-trip and the 1.7 methods.
- `openspec/changes/external-bulk-messaging/tasks.md` — B1 checkboxes marked `[x]`.

## Gotchas for B2/B3

- **`externalBulkPayloadHash` signature is `{templateName, variables, chatwootLabel, recipients:
  {phone, name?, variables?}[]}`** — NOT the older `{phones: string[]}` shape. `name` never enters the
  hash (cosmetic).
- **`ExternalBulkPreviewRecipient`** (`src/domain/entities/externalBulkPreview.ts`) now has
  `{phoneE164, phoneNormalized, name, variables}` — `variables` here is the recipient's MERGED map
  (global + per-recipient), not the raw per-recipient override.
- **`ExternalBulkPreviewInvalidEntry`** has an optional `missingVariables?: string[]` for
  `reason:'variables_faltantes'` (VAL-10).
- **`EmptyRecipientsError`** (`EMPTY_RECIPIENTS`, 422) is new in `domain/errors/external-bulk-messaging.ts`
  — use it when the whole batch ends up with zero `valid` recipients (VAL-10 scenario).
- **Prisma `migrate diff` in this repo's Prisma 7 uses `--from-schema`/`--to-schema`**, NOT
  `--from-schema-datamodel`/`--to-schema-datamodel` (removed flag). `prisma/prisma.config.ts` is
  loaded automatically; ignore the "Update available 7.8.0 -> 8.0.0-rc.12" banner on stderr.
- **`CampaignRecipient.variables`** (Prisma `Json?`, no default) needs `Prisma.JsonNull` for explicit
  SQL NULL in `createMany` (a bare `undefined` is not tolerated by `createMany` the way it is by
  `create`/`update`) — see `toRecipientVariablesJson` in `PrismaCampaignRepository.ts`.
- **`bootstrapApiUser`/`API_USER_*` exports are UNCHANGED** (backcompat) — `bootstrapMachineUser` is
  the new generalized function; `bootstrapApiMessagingUser`/`API_MESSAGING_USER_*` is the analogous
  wrapper for `login:'api-messaging'`.
- Read `openspec/changes/external-bulk-messaging/tasks.md` task **3.5**'s note before touching
  `matchManualContacts`/`resolveCombinedRecipients`/`CreateCampaign` in B3 — it explicitly says which
  of D4.e's 8 points are ALREADY DONE (5, 6, 7 — this batch) vs still pending (1-4, 8).

---

# Fix wave F1 (adversarial review, 3 revisores) — 2026-09-02

Ola de correcciones sobre la implementación completa, en TDD estricto: por cada finding un test que
falla PRIMERO contra el código actual, después el fix, después verde. Los findings CRITICAL/HIGH
llevan además un contrafáctico (correr el probe nuevo contra el código PRE-fix) donde el modo de
falla era sutil.

## Gate final

- `npx tsc --noEmit` → limpio (exit 0).
- `npm test` (suite COMPLETA) → **1253 suites passed** (+6 skipped, 1259 total),
  **13019 tests passed** (+88 skipped, 13107 total).
- `git status --short` → solo archivos del change.

## Los 15 findings

| # | Sev | Qué estaba mal | Fix |
|---|-----|----------------|-----|
| F1 | CRITICAL | `express.json({limit:'2mb'})` DENTRO del mount = código muerto: el `app.use(express.json())` global (100kb) corre antes y setea `req._body`. 1000 destinatarios (~145 KB) → 413 antes del auth | Parser movido al bloque path-scoped ANTES del global (`app.ts:~1280`), junto a los 3 overrides que ya documentan esta clase |
| F2 | HIGH | El cupo diario contaba `status:'sent'`, que va detrás del trabajo ya autorizado ⇒ tope inexigible (K1/K2/K3 → 3N con cap 2N) + `delivered` desaparecía del conteo | Port renombrado a `countAuthorizedRecipientsByCreatorSince`: cuenta recipients CREADOS desde el inicio del día ART (inclusivo) con `status NOT IN (skipped, opted_out)`. Paridad campo-a-campo Prisma/InMemory |
| F3 | HIGH | `replay()` salteaba el kill-switch y llamaba `start()` a ciegas sobre campañas `done`/`failed`/`running` | Flag fail-closed también en replay; `done`/`failed` → 200 `resumed:false` sin arrancar; `running` → `resumed:true` sin arrancar; `pending`/`paused` → start (busy ⇒ 409). Caps NO se re-chequean (ya se contaron) |
| F4 | HIGH | `maxPerRequest` sin techo vs `MAX_MANUAL_CONTACTS` (5000): con 6000, `validate` 200 y `send` 422 para siempre | `SetExternalBulkConfig` rechaza `> 5000` con 400 nombrando el techo; `ValidateExternalBulk` clampea defensivamente |
| F5 | MEDIUM | Sin backstop P2002 sobre `Campaign.externalIdempotencyKey`: dos `send` concurrentes ⇒ 500 | `UniqueConstraintViolationError` (`domain/errors/persistence.ts`), traducido en `PrismaCampaignRepository.create`; el use case re-lee por key y devuelve la campaña ganadora |
| F6 | MEDIUM | AUDIT-1/2 sin cumplir: `actorLogin:'anonymous'` + un `console.log` que no es auditoría | `machineActorMiddleware(rbacUserRepo, API_MESSAGING_USER_LOGIN)` en el mount; `console.log` eliminado. Filas reales para validate 200/422 y send 202/409 |
| F7 | MEDIUM | El rate limiter de escritura cubría el prefijo entero, incl. el polling de `GET /campaigns/:id` que el propio SEND-8 pide | Entra como `writeRateLimiter` en las deps del router y se aplica SOLO a los 4 POST |
| F8 | MEDIUM | 3 use cases importaban `API_MESSAGING_USER_LOGIN` de `@infrastructure/` (DIP roto) | Constante en `@domain/constants/machineUsers`; el bootstrap la RE-EXPORTA. Guard estático nuevo sobre TODA la capa `application/` |
| F9 | MEDIUM | El camino externo pasaba `allowedBulkActions: undefined` (= sin enforcement) y construía su propio `CreateCampaign` con 3 de 7 deps | Allowlist EXPLÍCITO (sin `'*'`) ⇒ un estado de cliente no mapeado bloquea; instancia de `CreateCampaign` COMPARTIDA con el router admin |
| F10 | LOW | `consumedAt` se chequeaba antes que `expiresAt`, al revés de SEND-2 | Swap: vencido (410) antes que consumido (409) |
| F11 | LOW | `hasArMobileMarker` daba `true` para CUALQUIER crudo de 12 dígitos ⇒ un extranjero podía reconstruirse como `+549…` (**envío al número equivocado**) | `classifyArPhone` con 3 resultados; si el crudo es internacional explícito (`+`/`00`) el país DEBE ser 54; el "15" local debe caer en un borde de área válido |
| F12 | LOW | Variables NO declaradas llegaban a `CampaignRecipient.variables` y de ahí a Twilio | Filtro a las keys declaradas por el template, en `validate` (persistencia + hash + respuesta) y otra vez en `send` |
| F13 | LOW | ¿El match reescribe el destino? | **VERIFICADO: match EXACTO por `normalizePhone`** (`byPhone.get(...)`); el índice de sufijos solo EXCLUYE opt-outs, nunca vincula. **Cero cambio de código**; 3 tests pinean que el E.164 enviado es el del input |
| F14 | LOW | `updatedAt` FABRICADO en el `GET` de config antes del primer `PUT` | La fila singleton se crea perezosamente (`upsert` con `update:{}`); fail-soft a los defaults si el upsert falla |
| F15 | LOW | Doc drift | Comentario de `ExternalBulkPreview.recipients` en `schema.prisma` corregido a los 4 campos reales + nota de que entran al re-hash; design D12/D14 declara que `GET /campaigns/:id` NO está gateado por el kill-switch A PROPÓSITO |

**Aceptado sin cambio**: los 401 no están rate-limited (igual que el mount externo global;
`safeCompare` + entropía de la key lo hacen no explotable).

## Contrafácticos corridos (revert-probe)

- **F2**: con la semántica vieja (`status:'sent'`) restaurada en el InMemory, el test K1/K2/K3 falla
  (`Received promise resolved instead of rejected`). Confirmado que el test discrimina.
- **F1**: el propio test mecánico incluye el orden VIEJO como caso explícito (413) contra el orden
  nuevo (200) — el contrafáctico queda pineado DENTRO del test, no solo corrido a mano.
- **F3/F10/F11/F12/F14/F4/F5/F9**: RED observado antes del fix en cada caso (2-5 tests fallando por
  finding).

## Archivos tocados

**Nuevos**
- `src/domain/constants/machineUsers.ts` — `API_MESSAGING_USER_LOGIN` (F8).
- `src/domain/errors/persistence.ts` — `UniqueConstraintViolationError` (F5).
- `src/infrastructure/http/middleware/machineActorMiddleware.ts` — actor máquina para el audit (F6).

**Modificados (código)**
- `src/application/use-cases/messaging/SendExternalBulk.ts` — F2, F3, F5, F6, F8, F9, F10, F12.
- `src/application/use-cases/messaging/ValidateExternalBulk.ts` — F2, F4 (clamp), F8, F11, F12.
- `src/application/use-cases/messaging/SetExternalBulkConfig.ts` — F4.
- `src/application/use-cases/messaging/GetExternalBulkCampaign.ts` — F8.
- `src/application/dto/external-bulk-messaging.dto.ts` — `resumed`/`status` en el output de send (F3).
- `src/domain/ports/CampaignRepository.ts` + `PrismaCampaignRepository.ts` + `InMemoryCampaignRepository.ts` — F2, F5.
- `src/infrastructure/adapters/prisma/PrismaExternalBulkMessagingConfigRepository.ts` — F14.
- `src/infrastructure/http/routes/external-messaging.routes.ts` — F7, F3 (200 vs 202).
- `src/infrastructure/http/app.ts` — F1, F6, F7, F9 + marcador `[external-bulk-mount-end]`.
- `src/infrastructure/bootstrap/bootstrapApiMessagingUser.ts` — re-export (F8).
- `prisma/schema.prisma` — comentario de `ExternalBulkPreview.recipients` (F15).

**Modificados (tests)**
- `src/__tests__/domain/domainLayerPurity.test.ts` — guard NUEVO de la capa `application` (F8).
- `src/__tests__/application/messaging/SendExternalBulk.test.ts` — F2, F3, F5, F9, F10, F12, F13.
- `src/__tests__/application/messaging/ValidateExternalBulk.test.ts` — F4, F11, F12, F13.
- `src/__tests__/application/messaging/SetExternalBulkConfig.test.ts` — F4.
- `src/__tests__/infrastructure/external-messaging.routes.test.ts` — F6, F7, F3.
- `src/__tests__/infrastructure/external-bulk-messaging-composition.test.ts` — F1 (estático + mecánico), ventana robusta (R3 #5), F6/F7/F9.
- `src/__tests__/infrastructure/adapters/in-memory/InMemoryCampaignRepository.test.ts` — F2 (+ borde inclusivo).
- `src/__tests__/infrastructure/PrismaCampaignRepository.externalIdempotency.test.ts` — F2.
- `src/__tests__/infrastructure/PrismaExternalBulkMessagingConfigRepository.test.ts` — F14.
- `src/__tests__/infrastructure/messaging-bulk-composition.test.ts` — actualizado por el hoist de `bulkCreateCampaign` (F9).
- `src/__tests__/application/messaging/SendCampaign.test.ts` — rename del método del port (F2).

## Cambios de contrato (leer antes de tocar el consumidor)

1. **`POST .../send` — replay devuelve 200, no 202.** Un `send` FRESCO sigue siendo 202
   `{campaignId, accepted, total}`. El REPLAY (GUARD-0 hit) ahora es **200** y agrega DOS campos
   ADITIVOS: `resumed: boolean` y `status: 'pending'|'running'|'done'|'failed'|'paused'`.
   `resumed:false` = la campaña ya había terminado y NO se re-arrancó.
2. **`PUT /api/messaging/config/external-bulk`** rechaza `maxPerRequest > 5000` con un 400 nuevo:
   `"maxPerRequest cannot exceed 5000 (hard cap of the bulk send engine)"`. El FE muestra los
   mensajes de 400 verbatim ⇒ **es una copy nueva que va a ver el usuario**.
3. **`validate`**: un número extranjero explícito ahora cae en `invalid` con
   `reason:'telefono_invalido'` (antes `non_mobile`, o peor: entraba en `valid` con un `+549…`
   inventado). `valid[].variables` trae SOLO las keys declaradas por el template (las extra se
   siguen aceptando en el input y se ignoran, VAL-10).

Nada más cambia de forma en el wire.

## Gotchas descubiertos en esta ola

- **`toWhatsAppE164` reconstruye extranjeros de 12 dígitos.** Un `+57 315 234 5678` tiene el "15" en
  un borde de área AR válido (área de 3), así que `stripLocal15` lo acepta y devuelve
  `+5495732345678`. La única defensa robusta es el FORMATO del crudo (`+`/`00` ⇒ el país debe ser
  54), no la longitud. `toWhatsAppE164` NO se tocó (lo comparte el bulk admin) — el gate vive en
  `ValidateExternalBulk`, único punto de entrada del camino externo.
- **`normalizePhone` es lossy y ASIMÉTRICO.** `011 15-2345-6789` → `111523456789` pero
  `+54 9 11 2345-6789` → `1123456789`: el MISMO número no matchea entre esas dos formas (el "15"
  embebido no se quita cuando no hay prefijo de país). Gap ya documentado en
  `matchActiveClient.ts:33-35`; muerde al escribir fixtures de "cliente vinculado".
- **El `indexOf(');')` del composition-root test cortaba dentro del primer `new ValidateExternalBulk(`**:
  la ventana quedaba en ~3 líneas y todo `expect(window).not.toMatch(...)` pasaba por VACUIDAD. Ahora
  se recorta con el marcador `[external-bulk-mount-end]` + un guard anti-vacuidad
  (`length > 500` + presencia de la última dep) + filtrado de líneas de comentario (los comentarios
  del propio bloque NOMBRAN `express.json(` y `new CreateCampaign(` al explicar por qué ya no están).
- **`app.use('/api/external/v1/messaging/bulk',` aparece DOS veces** en `app.ts` desde F1 (el parser
  y el router). Los tests estáticos usan `lastIndexOf` + verifican que la ventana arranque con
  `createApiKeyMiddleware`.
- **`ts-jest` es más estricto que `tsc --noEmit`** sobre `ReadonlySet` vs `Set` en la posición de un
  parámetro: `allowedBulkActions?: Set<string> | string[]` no acepta un `ReadonlySet`.
- **Un body de 3000 recipients "cortos" no llega a 100 KB.** El test mecánico del parser necesita
  ~12000 entradas para superar el default de `express.json()` — asertar el TAMAÑO antes de asertar
  el status code evita un test que "pasa" sin ejercitar nada.
- **El audit middleware SÍ registra los 4xx** (`isError` solo cambia `afterJson`/`errorMessage`), así
  que AUDIT-1 "el rechazo también audita" no necesitaba código nuevo: lo que faltaba era el actor.

---

# Fix wave F2 (2 findings NEW, post-F1) — 2026-09-02

Segunda ola, TDD estricto: red real (`npx jest`) antes de cada fix, verde después. Sin backfill —
la migración `20261112000000_external_bulk_messaging` no está deployada en ningún lado todavía, así
que amendarla es correcto (no hay una segunda migración para el índice nuevo).

## Gate final

- `npx tsc --noEmit` → limpio (exit 0).
- `npm test` (suite COMPLETA) → **1254 suites passed** (+6 skipped, 1260 total),
  **13030 tests passed** (+88 skipped, 13118 total). Mismo ruido pre-existente de teardown
  (`AuditEvent`/`Cannot log after tests are done`) que F1 ya flagueó, no introducido acá.
- `git status --short` → solo archivos de este fix wave (ver abajo).

## Los 2 findings

| # | Sev | Qué estaba mal | Fix |
|---|-----|----------------|-----|
| NEW-1 | MEDIUM | La traducción P2002→`UniqueConstraintViolationError` en `PrismaCampaignRepository.create` NO tenía scope: CUALQUIER P2002 (target que fuera, o sin `meta.target` legible) se traducía igual — y el test F5 de `SendExternalBulk` (carrera de idempotencia) espiaba `campaignRepo.create` para REJECTEAR con un error pre-construido a mano, así que el `InMemoryCampaignRepository` nunca hacía cumplir el `@unique` real y el path REAL de colisión nunca se ejercitaba | `InMemoryCampaignRepository.create` ahora lanza `UniqueConstraintViolationError('Campaign', 'externalIdempotencyKey')` si otra campaña ya tiene la misma key (paridad campo-a-campo con el `@unique` real). `PrismaCampaignRepository.create` solo traduce cuando `meta.target` incluye `externalIdempotencyKey`; cualquier otro P2002 sube tal cual. `SendExternalBulk` chequea `err.field === 'externalIdempotencyKey'` antes de asumir que es LA carrera de idempotencia. El test F5 se reescribió para pre-crear la campaña ganadora en el repo REAL y hacer que el guard-0 falle UNA vez (mock solo del lookup), dejando que el `create` real choque contra el unique — sin espiar `create` ni pre-construir el error |
| NEW-2 | LOW/MEDIUM | `countAuthorizedRecipientsByCreatorSince` (cupo diario, D3.a/D6) filtra `CampaignRecipient` por `createdAt >= since` en CADA `send`/`validate` externo sin un índice que lo respalde — full scan de la tabla | `@@index([createdAt])` agregado a `CampaignRecipient` en `schema.prisma` + `CREATE INDEX "CampaignRecipient_createdAt_idx"` amendado a LA MISMA migración `20261112000000_external_bulk_messaging` (todavía no deployada, sin backfill necesario). Verificado con `prisma migrate diff --from-schema <HEAD> --to-schema prisma/schema.prisma --script`: el SQL de la migración es EXACTAMENTE igual al diff completo HEAD→ahora (6 statements, mismo orden) + `npx prisma generate` corrido desde este worktree |

## Contrafácticos corridos (revert-probe)

- **NEW-1 (InMemory)**: sin el chequeo de unique en `create()`, `repo.create()` con una key repetida
  resuelve en vez de rechazar — confirmado RED real antes del fix (`Received promise resolved
  instead of rejected`).
- **NEW-1 (Prisma scope)**: con el `create()` viejo (traduce CUALQUIER P2002), un P2002 de OTRA
  columna (`target: ['id']`) o sin `meta.target` se traduce igual a `UniqueConstraintViolationError`
  en vez de subir tal cual — 3 tests fallando confirmados antes del fix.
- **NEW-1 (SendExternalBulk field check)**: mutado el guard a `err.field === 'MUTATED-not-a-real-field'`
  (typecheck-safe, preserva la narrowing de `err instanceof`) → el test F5 reescrito FALLA (el
  `UniqueConstraintViolationError` real del InMemory sube sin capturarse). Revertido, 38/38 de nuevo.
- **NEW-2**: pin estático (schema + SQL) — RED confirmado antes de tocar `schema.prisma`/la migración
  (ambos `toMatch` fallaban), GREEN después.

## Archivos tocados

**Modificados (código)**
- `src/infrastructure/adapters/in-memory/InMemoryCampaignRepository.ts` — NEW-1, chequeo de unique en `create()`.
- `src/infrastructure/adapters/prisma/PrismaCampaignRepository.ts` — NEW-1, scope del P2002 a `externalIdempotencyKey`.
- `src/application/use-cases/messaging/SendExternalBulk.ts` — NEW-1, `err.field === 'externalIdempotencyKey'` antes del re-read.
- `prisma/schema.prisma` — NEW-2, `CampaignRecipient.@@index([createdAt])`.
- `prisma/migrations/20261112000000_external_bulk_messaging/migration.sql` — NEW-2, `CREATE INDEX "CampaignRecipient_createdAt_idx"` amendado (migración propia del change, sin deploy).

**Modificados (tests)**
- `src/__tests__/infrastructure/adapters/in-memory/InMemoryCampaignRepository.test.ts` — NEW-1, 3 casos (choque/keys distintas/null no choca).
- `src/__tests__/infrastructure/PrismaCampaignRepository.externalIdempotency.test.ts` — NEW-1, 5 casos (target simple/compuesto/otra columna/sin target/no-P2002).
- `src/__tests__/application/messaging/SendExternalBulk.test.ts` — NEW-1, F5 reescrito contra el InMemory real + 1 caso nuevo (field distinto sube tal cual).

**Nuevos (tests)**
- `src/__tests__/infrastructure/external-bulk-messaging-recipient-createdAt-index.test.ts` — NEW-2, pin del índice en schema + migración (molde `conversation-labels-migration.test.ts`).

## Gotchas descubiertos en esta ola

- **`Prisma migrate diff` en Prisma 7 de este repo**: `--from-schema`/`--to-schema` (ya documentado en
  F1), reconfirmado — sigue siendo el flag correcto en Prisma 7.8.0.
- **Mutación de un guard `err instanceof X && err.field === Y` con `false &&` rompe el narrowing de
  TypeScript** dentro del bloque `catch (err)` tipado `unknown` — `ts-jest` tira `TS18046`/`TS18047`
  en cascada (el compilador ya no puede probar que `err`/`winner` no son `unknown`/`null` dentro del
  bloque muerto). El mutation-probe tiene que cambiar el VALOR comparado (`err.field === 'algo que no
  matchea'`), no envolver la condición en `false &&`, para mutar en runtime sin romper el typecheck.
- **`CampaignCreateData.variableSpec` necesita tipado explícito en un fixture de test fuera de una
  función con return-type anotado** — `{ '1': { source: 'name' } }` sin anotar el objeto como
  `CampaignCreateData` widena `source` a `string` y `tsc`/`ts-jest` lo rechaza contra
  `CampaignVariableSource` (`'name'|'balanceDue'|'literal'`); `makeCreateData()` en el test de
  InMemory ya lo evitaba con el return-type de la función, un `const` suelto no.
