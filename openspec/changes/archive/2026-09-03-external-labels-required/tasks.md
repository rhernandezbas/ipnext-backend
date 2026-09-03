# Tasks — external-labels-required

**Change**: external-labels-required · **Repo BE**: este worktree
(`.claude\worktrees\external-labels-required-be`). **Sin repo FE** (el composer admin no se toca).
**TDD estricto**: RED → GREEN → refactor. Use cases REALES + `FakeChatwootGateway`; JAMÁS mockear
el use case ni Prisma. Cada batch cierra con `npm test` + `npx tsc --noEmit` verdes — **no**
`npm run build` (regla del repo). **Matriz spec↔test**: cada task cita el requirement
(`external-labels` LBL-* o el delta de `external-bulk-messaging` VAL-1/VAL-5/SEND-4).
**Dependencias**: B1 (rutas de labels, autocontenido) → B2 (obligatorio en validate/send, rompe
fixtures compartidos) → B3 (post-deploy). B1 y B2 tocan el MISMO archivo de rutas y el MISMO test
de rutas: hacerlos en orden, no en paralelo.
**Riesgos a vigilar** (design D1-D5): el 422 NO puede salir del Zod (sería 400); las rutas nuevas
van ANTES del catch-all (`external-messaging.routes.ts:283`); no tocar `messagingBulk.routes.ts`,
`CreateChatwootLabel.ts` ni `HttpChatwootGateway.ts`; no romper el marcador
`[external-bulk-mount-end]` (`app.ts:3696`).

---

## Batch 1 — `GET/POST /labels` en la API Externa (LBL-1..LBL-5, design D2/D3/D4)

- [x] **1.1** RED `src/__tests__/infrastructure/external-messaging.routes.test.ts`: `describe('GET /labels')`
  — 200 con catálogo, 200 con `{data:[]}`, 503 con `failListAccountLabels`, y N+1 GET sin 429
  (LBL-1). Extender `buildApp` con las 2 deps nuevas.
- [x] **1.2** RED, mismo archivo: `describe('POST /labels')` — 201 normalizando `"  Prueba API
  Externa  "` → `prueba-api-externa` (asserteando `createAccountLabelCalls[0].title`), color
  explícito, color default, color inválido → 400, title whitespace → 400, `description` → 400
  (LBL-2).
- [x] **1.3** RED, mismo archivo: **200 idempotente** `{...existingLabel, created:false}` con el
  catálogo sembrado — `createAccountLabelCalls.length === 0` (decisión del orquestador, reemplaza el
  409 `CHATWOOT_LABEL_EXISTS` original); 503 con `failCreateAccountLabel`; 401 sin key; 403 con flag
  OFF y con el repo de flags tirando (ambas rutas, sin llamar a Chatwoot); POST rate-limitado
  (LBL-2/LBL-3).
- [x] **1.4** RED, mismo archivo: auditoría — `POST /labels` deja fila con
  `actorLogin:'api-messaging'` y `actorId` no nulo; `GET /labels` no deja ninguna, vía
  `InMemoryAuditEventRepository` (LBL-4).
- [x] **1.5** GREEN `src/domain/errors/external-bulk-messaging.ts`: actualizar el comentario del
  mapping del encabezado (LBL-2 no agrega ninguna clase de error nueva — el duplicado es 200
  idempotente, decisión del orquestador, no un throw).
- [x] **1.6** GREEN `src/infrastructure/http/middleware/errorHandler.ts`: sin entrada nueva para
  LBL-2 (sin cambios — el duplicado no es un error; `CHATWOOT_LABEL_REQUIRED: 422` de Batch 2 es la
  única entrada nueva del change).
- [x] **1.7** GREEN `src/infrastructure/http/routes/external-messaging.routes.ts`:
  `DEFAULT_LABEL_COLOR`, `normalizeLabelTitle()`, `CreateLabelBodySchema` (`.strict()`), las 2 deps
  en `ExternalMessagingRouterDeps`, y las rutas `GET /labels` (sin `writeLimit`) + `POST /labels`
  (con `writeLimit`) registradas **ANTES del catch-all**.
- [x] **1.8** GREEN `src/infrastructure/http/app.ts`: inyectar `new ListChatwootLabels(chatwootGatewayForBulk)`
  y `new CreateChatwootLabel(chatwootGatewayForBulk)` en el mount, sin mover el marcador
  `[external-bulk-mount-end]`.
- [x] **1.9** No-regresión (LBL-5): correr `messagingBulk.routes.test.ts`,
  `CreateChatwootLabel.test.ts` y `ListChatwootLabels.test.ts` **sin tocarlos** — deben quedar
  verdes; `git diff --stat` NO debe listar `messagingBulk.routes.ts` ni `CreateChatwootLabel.ts`.
  **DONE** — 103/103 verdes, `git diff --stat` confirma ninguno de los 2 archivos tocado.

## Batch 2 — `chatwootLabel` obligatorio (VAL-1, VAL-5, SEND-4, design D1/D5)

- [x] **2.1** RED `src/__tests__/application/messaging/ValidateExternalBulk.test.ts`: sin label,
  `''` y `'   '` → `ChatwootLabelRequiredError`; `listAccountLabels` NO fue llamado; con el flag OFF
  gana `FeatureExternalBulkDisabledError` (VAL-1).
- [x] **2.2** GREEN `src/domain/errors/external-bulk-messaging.ts` + `errorHandler.ts`:
  `ChatwootLabelRequiredError` (`CHATWOOT_LABEL_REQUIRED`) + `CHATWOOT_LABEL_REQUIRED: 422`.
- [x] **2.3** GREEN `src/application/dto/external-bulk-messaging.dto.ts` (`chatwootLabel: string`,
  sin `?`) + `ValidateExternalBulk.ts`: `assertValidShape` exige el label no-vacío tras `trim`, el
  paso 6 (`assertLabelExists`) pasa a incondicional (VAL-1/VAL-5).
- [x] **2.4** Fixtures compartidos: agregar un `chatwootLabel` default **en el helper** de
  `ValidateExternalBulk.test.ts` (las ~60 `execute(`) y en `VALID_BODY` +
  `buildApp({chatwootLabels})` de `external-messaging.routes.test.ts`, sembrando el catálogo del
  fake con ESE título. **Nunca test por test.** También aplicado a `SendExternalBulk.test.ts`
  (`buildPreviewData`/`setup`, mismo problema no anticipado explícitamente en el design pero con
  idéntico blast radius — 58 `buildPreviewData(` sin label).
- [x] **2.5** RED `src/__tests__/application/messaging/SendExternalBulk.test.ts`: preview con
  `chatwootLabel:null` → `ChatwootLabelRequiredError`; label borrado del catálogo →
  `ChatwootLabelNotFoundError`; en ambos, ni `Campaign` creada ni preview consumido (SEND-4).
- [x] **2.6** GREEN `src/application/use-cases/messaging/SendExternalBulk.ts:167`: guard de
  `null`/vacío → `ChatwootLabelRequiredError`, después `assertLabelExists` incondicional.
- [x] **2.7** RED+GREEN `external-messaging.routes.test.ts`: `POST /validate` sin `chatwootLabel`
  → **422** `CHATWOOT_LABEL_REQUIRED` (no 400 — pinea D1) y con label válido → 200.
- [x] **2.8** Suite completa: `npm test` + `npx tsc --noEmit` verdes. Revisar los composition tests
  (`external-bulk-messaging-composition.test.ts`, `twilio-credit-guard-composition.test.ts`,
  `external-messaging-templates.routes.test.ts`) por bodies de `validate` sin label.
  **DONE** — `external-bulk-messaging-composition.test.ts` y `external-messaging-templates.routes.test.ts`
  construyen `ExternalMessagingRouterDeps` DIRECTAMENTE (no vía `app.ts`) → les faltaban
  `listChatwootLabels`/`createChatwootLabel` (error de TS, no de body sin label — sus `/validate`
  ahí solo prueban 401/403, gates que corren ANTES de `assertValidShape`). `twilio-credit-guard-composition.test.ts`
  no construye deps ni llama `/validate` — sin cambios. `npx tsc --noEmit` limpio. `npm test`:
  1266/1272 suites verdes (6 skipped, pre-existentes, no tocados por este change), 13300/13388 tests
  verdes (88 skipped, pre-existentes), 0 fallos, jest processes = 0 al final.

## Batch 3 — Post-deploy (fuera de `sdd-apply`, lo corre el orquestador)

- [ ] **3.1** Smoke en vivo, los 6 pasos de `design.md` §Smoke (incluye crear
  `prueba-api-externa` y verificarlo en Chatwoot).
- [x] **3.2** ~~Confirmar con el usuario `DEFAULT_LABEL_COLOR` y la open question del 409 vs 200
  idempotente.~~ Resuelto por el orquestador antes de `sdd-apply` (2026-09-03): `DEFAULT_LABEL_COLOR`
  confirmado sin cambios, 409 descartado a favor del 200 idempotente. Ver design.md D3/Open
  Questions.
- [ ] **3.3** Sección "Labels" en la skill `whatsapp-bulk-ipnext` (SKILL.md único): `GET/POST
  /labels`, la regla de normalización, el 409, y el **breaking change** (`chatwootLabel` obligatorio
  en `validate`). Sólo con 3.1 verde.

## Batch 4 — Fix wave F1 (review adversarial post-apply, 2026-09-03)

TDD estricto, MISMO criterio de Batch 1/2. 7 findings, todos GREEN en este worktree (staged, sin
commitear). Ver design.md §"Fix wave F1" para el detalle de cada decisión.

- [x] **4.1** (finding 1, HIGH) RED+GREEN `external-messaging.routes.ts`: `ValidateBodySchema.chatwootLabel`
  pasa de `z.string().optional()` a `z.string().nullable().optional()` — un `chatwootLabel: null`
  EXPLÍCITO reventaba el Zod (400) en vez de llegar a `assertValidShape` (422
  `CHATWOOT_LABEL_REQUIRED`). Test: `null`/ausente/`""`/`"   "` → los 4 en 422.
- [x] **4.2** (finding 2, HIGH) Nuevo `src/application/use-cases/messaging/normalizeLabelTitle.ts`
  — `normalizeLabelTitle` se muda de constante local de la ruta a helper COMPARTIDO. `ValidateExternalBulk`
  normaliza el `chatwootLabel` del caller antes de matchear contra el catálogo y de persistirlo en el
  preview; `SendExternalBulk` lo normaliza de forma DEFENSIVA sobre `preview.chatwootLabel` y pasa el
  valor normalizado a `CreateCampaign`. `ValidateExternalBulkOutput.chatwootLabel` (aditivo, D12).
  Test: round-trip `POST /labels` → `POST /validate` (título "bonito") → `POST /send` (Campaign con
  el título canónico), a nivel HTTP y a nivel use case.
- [x] **4.3** (finding 3, MEDIUM) `external-messaging.routes.ts`: (a) charset del título
  (`/^[\p{L}\p{N}_-]+$/u`, chequeado DESPUÉS de normalizar) → 400 con los caracteres ofensores
  listados; (b) TOCTOU del `POST /labels` — si `createAccountLabel` falla, re-listar el catálogo UNA
  vez antes de declarar 503; si el título ya existe, 200 idempotente `{created:false}`.
- [x] **4.4** (finding 4, MEDIUM) `CreateLabelBodySchema.title`: `z.string().min(1).max(100)`.
- [x] **4.5** (finding 5, LOW) `SendExternalBulk.ts` (SEND-4): el guard `CHATWOOT_LABEL_REQUIRED` se
  movió ANTES de `assertTemplateApproved`. Test: preview `chatwootLabel:null` + template YA no
  aprobado → 422 `CHATWOOT_LABEL_REQUIRED` (no `TEMPLATE_NOT_APPROVED`).
- [x] **4.6** (finding 6, LOW) `external-messaging.routes.test.ts`: el test de `GET /labels` con flag
  OFF pasó de `expect(chatwootGateway.accountLabelsResult).toBeDefined()` (tautológico) a un spy
  sobre `listAccountLabels` + `not.toHaveBeenCalled()`. El test de rate-limit de `POST /labels` pasó
  de "algún 429 en algún lado" a `toEqual([201, 201, 429, 429])` (limit:2).
- [x] **4.7** (finding 7) Escenarios agregados: round-trip create→validate→send (HTTP y use case),
  `chatwootLabel: null` vía HTTP, rechazo de charset — ver design.md y los 2 specs delta.
- [x] **4.8** `src/__tests__/helpers/FakeChatwootGateway.ts`: `createAccountLabel` ahora persiste el
  label creado en `accountLabelsResult` (antes NO lo hacía) — necesario para que el round-trip
  create→validate se pueda probar de punta a punta vía HTTP sin fixture manual; simula el
  comportamiento REAL de Chatwoot (crear ⇒ aparece en el listado). No afecta ningún test existente
  (verificado: ninguno depende de que `accountLabelsResult` quede estático tras un `create`).
- [x] **4.9** Suite completa: `npx tsc --noEmit` limpio; `npm test` 1266/1272 suites verdes (6
  skipped, pre-existentes), 13330/13418 tests verdes (88 skipped, pre-existentes), 0 fallos, jest
  processes = 0 al final. `git status --short` solo lista archivos del change (ninguno de los 4
  prohibidos: `HttpChatwootGateway.ts`, `SendCampaign.ts`, `messagingBulk.routes.ts`,
  `CreateChatwootLabel.ts`).
