# Tasks — bulk-task-recipients

**Change**: bulk-task-recipients · **Phase**: tasks · **Repo BE**: este worktree
(`bulk-task-recipients-be`). **Repo FE**: `ipnext-frontend` (sección propia al final, apply DESPUÉS
del BE verde).

**TDD estricto**: RED → GREEN → refactor. Adapters in-memory para use cases
(`InMemoryTaskStageRecipientConfigRepository`, `InMemoryTaskRecipientSource`, molde
`InMemoryNocBroadcastConfigRepository`/`ManualRecipientSource` fixtures), JAMÁS mockear Prisma ni el
use case — seam completo (regla del repo). Los adapters Prisma en sí SÍ llevan un test de
"intención" con `jest.mock('.../database/prisma')` pineando los args exactos (molde
`PrismaChatMessageRepository.upsertTemplateMessage.test.ts`) — eso NO es mockear-Prisma-en-test-de-
use-case, es testear el adapter.

**Dependencias entre batches**:
```
B1 (schema) → B2 (ports/adapters) → { B3 (config CRUD), B4 (wire delta) } → B5 (branch resolver,
  depende de B2 + B4) → B6 (wiring app.ts, depende de B2/B3/B4/B5 completos)
```
B3 y B4 son paralelizables entre sí una vez B2 está verde (B3 = capability de config nueva; B4 = wire
del delta bulk — no se tocan entre sí). B5 depende de B4 (usa los errores/DTOs que B4 declara) y de B2
(usa `TaskRecipientSource`). El FE arranca solo cuando B1-B6 están verdes.

---

## Batch 1 — Migración Prisma: tabla config + índice compuesto (TSC-1, D1)

- [x] **1.1** Migración aditiva. Sugerido `npx prisma migrate diff --from-schema-datamodel
  prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` (molde
  `20261018000000_chatwoot_sendpath_delivery_status`, generación sin DB viva) o `npm run
  prisma:migrate` si hay DB local disponible — CUALQUIERA de las dos, nunca SQL a mano fuera de lo
  generado. Timestamp posterior a `20261018000000_chatwoot_sendpath_delivery_status` (última
  migración real del worktree — VERIFICADA: `ls prisma/migrations` la confirma como la más
  reciente). Sugerido `20261019000000_task_stage_recipient_config`. Contenido:
  - `CREATE TABLE "WhatsappTaskStageRecipientConfig" ("id" TEXT PK default uuid, "stageId" TEXT
    UNIQUE, "createdAt" TIMESTAMP default now())` + FK `stageId` → `Stage(id)` **ON DELETE CASCADE**
    (TSC-1: borrar un Stage limpia el mapeo solo).
  - `CREATE INDEX "ScheduledTask_stageId_isClosed_customerId_idx" ON "ScheduledTask"("stageId",
    "isClosed", "customerId")` — índice COMPUESTO nuevo, **ADITIVO** al `@@index([stageId])`
    existente (`schema.prisma:1406`, NO se borra — otros paths de scheduling lo usan, D1).
  - CERO cambio en `Campaign`/`CampaignRecipient` (verificado: `clientId` ya nullable de
    bulk-csv-recipients, `schema.prisma:3312`).
  - Test: N/A (schema). Verificado por 2.x/6.x (los adapters/composition fallarían en runtime si el
    modelo no existiera).
- [x] **1.2** `prisma/schema.prisma`: agregar `model WhatsappTaskStageRecipientConfig { id, stageId
  @unique, stage Stage @relation(onDelete: Cascade), createdAt }` + back-relation virtual en `Stage`
  (`whatsappTaskStageRecipientConfig WhatsappTaskStageRecipientConfig?`) + el `@@index([stageId,
  isClosed, customerId])` en `ScheduledTask` (junto al existente, no en su lugar). `npx prisma
  generate` post-edit.
- [x] **Gate B1**: `npx prisma generate` limpio (tipos `WhatsappTaskStageRecipientConfig` disponibles
  en `@prisma/client`); `tsc --noEmit` no rompe por el modelo nuevo.

## Batch 2 — Ports + adapters (TSC-2, D2)

- [x] **2.1** Port `domain/ports/TaskStageRecipientConfigRepository.ts` — `MappedStage {stageId,
  stageName, stageCode, color, workflowId, workflowName}` + interface `{ listMappedStageIds():
  Promise<string[]>; getMappedStages(): Promise<MappedStage[]>; replaceMappedStages(stageIds:
  string[]): Promise<void> }` (D2). Sin test propio (interfaz pura).
- [x] **2.2** Port `domain/ports/TaskRecipientSource.ts` — `{ listClientIdsByOpenTaskStages(stageIds:
  string[]): Promise<string[]>; countOpenTasksWithoutCustomer(stageIds: string[]): Promise<number>
  }` (D2, SEPARADO de `CustomerRepository`/`ManualRecipientSource` — disciplina D-pattern, no cuelga
  de un port existente). Sin test propio.
- [x] **2.3** RED+GREEN `InMemoryTaskStageRecipientConfigRepository`
  (`src/infrastructure/adapters/in-memory/InMemoryTaskStageRecipientConfigRepository.ts`, test en
  `src/__tests__/infrastructure/adapters/in-memory/InMemoryTaskStageRecipientConfigRepository.test.ts`,
  molde `InMemoryNocBroadcastConfigRepository.test.ts`): constructor recibe un catálogo fixture
  `stageId → {name, code, color, workflowId, workflowName}` (espeja el universo de `Stage`) + un `Set`
  interno mapeado.
  - Test: `replaceMappedStages([B,C])` sobre config `[A,B]` → queda EXACTAMENTE `[B,C]` (TSC-2
    scenario "replace-set reemplaza, no suma").
  - Test: `replaceMappedStages([])` sobre `[A,B,C]` → queda vacío, sin error (TSC-2 scenario
    "array vacío limpia toda la config").
  - Test: `replaceMappedStages(['s1','stage-inexistente'])` → rechaza TODO-O-NADA (espeja la FK real
    de Prisma) — la config previa NO cambia (molde TSC-4 "stageId inexistente → rechazado, nada se
    aplica", aplicado acá al mirror in-memory).
  - Test: `getMappedStages()` devuelve hidratado (`stageId,name,code,color,workflowId,workflowName`)
    para cada id del Set mapeado.
- [x] **2.4** RED+GREEN `InMemoryTaskRecipientSource`
  (`src/infrastructure/adapters/in-memory/InMemoryTaskRecipientSource.ts`, test en
  `src/__tests__/infrastructure/adapters/in-memory/InMemoryTaskRecipientSource.test.ts`): fixture de
  tareas `{clientId: string|null, stageId, isClosed}` (una tarea con `clientId:null` simula la de red,
  TASK-3).
  - Test: `listClientIdsByOpenTaskStages(['stageA','stageB'])` — cliente con 5 tareas abiertas
    repartidas entre A y B → aparece UNA sola vez (distinct, TASK-3 scenario 1).
  - Test: stage mapeado sin tareas abiertas → `[]`, sin error (TASK-3 scenario 2).
  - Test: tarea `clientId:null` en un stage pedido → NO aparece en `listClientIdsByOpenTaskStages`,
    SÍ la cuenta `countOpenTasksWithoutCustomer` (TASK-3 scenario 3).
  - Test: tarea `isClosed:true` en el stage pedido, única tarea del cliente → cliente NO aparece
    (TASK-3 scenario 4).
- [x] **2.5** RED+GREEN `PrismaTaskStageRecipientConfigRepository`
  (`src/infrastructure/adapters/prisma/PrismaTaskStageRecipientConfigRepository.ts`) — adapter-
  intención con `jest.mock('.../database/prisma')` (molde
  `PrismaChatMessageRepository.upsertTemplateMessage.test.ts`), test en
  `src/__tests__/infrastructure/PrismaTaskStageRecipientConfigRepository.test.ts`:
  - `getMappedStages` → pinea `findMany({ include: { stage: { include: { workflow: true } } } })`.
  - `replaceMappedStages` → pinea `$transaction([deleteMany({}), createMany({ data:
    stageIds.map(id=>({stageId:id})) })])` (D2, ATÓMICO: si `createMany` falla por FK P2003, el
    `$transaction` completo rechaza — la config previa se preserva porque NUNCA commitea).
  - Un P2003 simulado (`mockPrisma.$transaction.mockRejectedValue({code:'P2003'})`) → el adapter lo
    traduce a `TaskStageNotFoundError` (2.7), NUNCA deja escapar el error crudo de Prisma.
- [x] **2.6** RED+GREEN `PrismaTaskRecipientSource`
  (`src/infrastructure/adapters/prisma/PrismaTaskRecipientSource.ts` — clase propia, D9 Open
  Question resuelta: se prefiere clase dedicada sobre método de `PrismaSchedulingRepository` para no
  acoplar esta capability nueva a un repo grande existente, mismo criterio D-pattern de 2.2), test en
  `src/__tests__/infrastructure/PrismaTaskRecipientSource.test.ts`:
  - `listClientIdsByOpenTaskStages` → pinea `scheduledTask.findMany({ where: { stageId: {in:
    stageIds}, customerId: {not: null}, isClosed: false }, select: {customerId: true},
    distinct: ['customerId'] })`, mapea a `string[]`.
  - `countOpenTasksWithoutCustomer` → pinea `scheduledTask.count({ where: { stageId: {in},
    customerId: null, isClosed: false } })`.
- [x] **2.7** Error nuevo `TaskStageNotFoundError` en **`src/domain/errors/messaging-task-stage-
  config.ts`** (archivo NUEVO — capability nueva = errores propios, molde precedente
  `domain/errors/nocBroadcast.ts`; **NO** en `messaging-bulk.ts`, ese archivo es del delta de
  resolución, ver desvío #3 al final). Code `TASK_STAGE_NOT_FOUND` → **422** en el statusMap
  (`errorHandler.ts`). Test: cubierto por 2.5 (el adapter lo lanza) — sin test standalone (mismo
  criterio que otros códigos sin `errorHandler.test.ts` dedicado).
- [x] **Gate B2**: suites de 2.3/2.4/2.5/2.6 verdes; `tsc --noEmit` limpio.

## Batch 3 — Config CRUD `/api/messaging/config/task-stages` (TSC-3, TSC-4, D6)

- [ ] **3.1** RED+GREEN `GetTaskStageRecipientConfig`
  (`src/application/use-cases/GetTaskStageRecipientConfig.ts`, molde `GetNocBroadcastConfig.ts`,
  test `src/__tests__/application/GetTaskStageRecipientConfig.test.ts`): `execute(): Promise<{
  stages: MappedStage[] }>` → delega en `configRepo.getMappedStages()`.
  - Test: 0 stages mapeados → `{ stages: [] }` (TSC-3 scenario "config vacía").
  - Test: N stages mapeados → `{ stages }` hidratado tal cual el repo devuelve.
- [ ] **3.2** RED+GREEN `UpdateTaskStageRecipientConfig`
  (`src/application/use-cases/UpdateTaskStageRecipientConfig.ts`, molde
  `UpdateNocBroadcastConfig.ts`, test `src/__tests__/application/UpdateTaskStageRecipientConfig.test.ts`):
  `execute({stageIds}): Promise<{ stages: MappedStage[] }>`.
  - **Dedup ANTES de persistir** (TSC-1 scenario "mapear el mismo stage dos veces es imposible"):
    `[...new Set(stageIds)]` antes de llamar `configRepo.replaceMappedStages(...)` — la
    constraint `@unique` de la DB es la última línea de defensa, NO la única (spec TSC-1).
  - Test: `execute({stageIds:['s1','s2']})` sobre ambos existentes → repo queda `[s1,s2]`
    EXACTAMENTE, retorna `{stages}` hidratado (TSC-4 scenario "replace-set exitoso").
  - Test: `execute({stageIds:['s1','stage-inexistente']})` → el repo in-memory rechaza (2.3), el
    use case propaga el error tal cual (`TaskStageNotFoundError`), config previa intacta (TSC-4
    scenario "stageId inexistente → rechazado, nada se aplica"). **Nota de arquitectura**: la
    atomicidad la garantiza el REPO (transacción/validación todo-o-nada, D2), el use case NO hace un
    pre-chequeo de existencia separado antes de llamar `replaceMappedStages` — evita una query extra
    redundante (ver desvío #2 al final).
  - Test: `execute({stageIds:['s1','s1','s2']})` → llama a `replaceMappedStages(['s1','s2'])`
    (dedup verificado por spy/mock del repo).
- [ ] **3.3** Router `createTaskStageConfigRouter`
  (`src/infrastructure/http/routes/taskStageConfig.routes.ts`, molde
  `createNocBroadcastRouter`/`nocBroadcast.routes.ts:30-76`), test
  `src/__tests__/infrastructure/http/routes/taskStageConfig.routes.test.ts` (supertest, repos
  in-memory inyectados):
  - `GET /` gate `messaging.read` → `GetTaskStageRecipientConfig.execute()` → 200 `{stages}`.
    Test: usuario CON `messaging.read` → 200 con stages hidratados (TSC-3 scenario 1). Test: usuario
    sin ningún permiso `messaging.*` → 403 `PERMISSION_DENIED`. Test: rol custom con
    `messaging.bulk` pero SIN `messaging.read` (fixture ad-hoc del rbac in-memory) → 403
    `PERMISSION_DENIED` — **esperado, NO bug** (TSC-3 scenario 2, decisión ya resuelta en el spec,
    ver desvío #1).
  - `PUT /` gate `messaging.manage`, body `{stageIds: string[]}` Zod `safeParse` (molde
    `UpdateNocBroadcastConfigSchema`/`nocBroadcast.routes.ts:51-62`) → 400 `VALIDATION_ERROR` si
    falla → si OK, `UpdateTaskStageRecipientConfig.execute({stageIds})` → 200 `{stages}`.
    Test: body `{stageIds:'no-es-array'}` → 400 `VALIDATION_ERROR`, config sin cambios (TSC-4
    scenario "payload malformado"). Test: usuario con SOLO `messaging.read` (sin `manage`) → 403
    (TSC-4 scenario "manage es estrictamente más restrictivo"). Test: `stageId` inexistente → el
    error tipado de 3.2 llega mapeado a 422 vía el errorHandler global.
- [ ] **Gate B3**: suites 3.1/3.2/3.3 verdes.

## Batch 4 — Wire del 5to dominio: parser, DTOs, guard de elegibilidad, errores (TASK-1, TASK-2 guard, D3, D5)

- [ ] **4.1** Errores nuevos en `src/domain/errors/messaging-bulk.ts` (ESTOS 3, distintos del de B2.7
  — ver desvío #3): `TaskStageNotEligibleError` (`TASK_STAGE_NOT_ELIGIBLE`, lleva
  `ineligibleStageIds: string[]`), `TooManyTaskStateRecipientsError` (`TOO_MANY_TASK_STATE_RECIPIENTS`,
  `received/max`, mensaje accionable "acotá los estados seleccionados"), `InvalidTaskStageIdsError`
  (reusa `VALIDATION_ERROR`, molde `InvalidManualRecipientsError`). statusMap
  (`errorHandler.ts`): `TASK_STAGE_NOT_ELIGIBLE: 422`, `TOO_MANY_TASK_STATE_RECIPIENTS: 422`. Sin
  test standalone (cubiertos por 4.2/5.x, mismo criterio que el resto de la familia).
- [ ] **4.2** RED+GREEN `assertTaskStagesEligible`
  (`src/application/use-cases/messaging/assertTaskStagesEligible.ts`, molde
  `assertHasRecipients.ts:16-24`), test
  `src/__tests__/application/messaging/assertTaskStagesEligible.test.ts`:
  `assertTaskStagesEligible(taskStageIds: string[], configRepo?: TaskStageRecipientConfigRepository):
  Promise<void>`. `taskStageIds` vacío → no-op INMEDIATO (nunca toca `configRepo`, ni siquiera
  exige que esté presente). No vacío + `configRepo` ausente → `Error` defensivo (molde
  `manualRecipientSource requerido`, nunca ocurre en wiring real). No vacío → `mapped = await
  configRepo.listMappedStageIds()`; algún id ∉ mapped → `TaskStageNotEligibleError(ineligibles)`.
  - Test: `['stageA']` mapeado, pide `['stageA','stageB']` → throw con `ineligibleStageIds:
    ['stageB']` (TASK-2 scenario 1).
  - Test: config vacía (`listMappedStageIds()` → `[]`), pide `['cualquiera']` → throw (TASK-2
    scenario "config vacía + request → 422").
  - Test: `taskStageIds: []` → resuelve sin llamar `configRepo` (verificable con spy count 0).
- [ ] **4.3** `toTaskStageIds(raw)` en `messagingBulk.routes.ts` (molde `toManualClientIds:77-88`):
  ausente → `[]`; no-array o item no-string → `InvalidTaskStageIdsError` (400 `VALIDATION_ERROR`).
  - Test (extiende `src/__tests__/infrastructure/messagingBulk.routes.test.ts`): body
    `taskStageIds: 'no-es-array'` en POST `/segment/preview`, POST `/segment/recipients`, POST
    `/campaigns` → 400 `VALIDATION_ERROR`, nada persistido (TASK-1 scenario "payload malformado").
  - **Paridad de deep-link GET** (D5): a diferencia de `manualClientIds`/`manualContacts` (que NO
    viajan por query, DET-3 — payload arbitrario), `taskStageIds` SÍ se agrega a GET
    `/segment/preview` y GET `/segment/recipients` vía `queryStatuses(req.query['taskStageIds'])`
    (mismo helper que `statuses`, `:62-65` — es una lista de ids cortos, no un payload libre).
    Test: `GET /segment/preview?taskStageIds=stageA&taskStageIds=stageB` parsea a
    `['stageA','stageB']`.
- [ ] **4.4** DTOs (`src/application/dto/messaging-bulk.dto.ts`): `taskStageIds?: string[]` en
  `PreviewSegmentInput` (lo hereda `ListSegmentRecipientsInput`) y `CreateCampaignInput`. Unión
  `source` de `SegmentRecipientItemDto`/`ExcludedRecipientItemDto` gana `'task'`.
  `PreviewSegmentOutput`/`ListSegmentRecipientsOutput` ganan `noCustomerCount: number`. Wire de
  handlers: `taskStageIds: toTaskStageIds(body?.['taskStageIds'])` en los 3 POST (`/segment/preview`,
  `/segment/recipients`, `/campaigns`) + `queryStatuses(...)` en los 2 GET (4.3). Sin test propio de
  tipos — verificado por 4.3/5.x/6.x (`tsc --noEmit` + los tests de ruta).
- [ ] **4.5** `assertHasRecipients` (`assertHasRecipients.ts`) gana 4to parámetro `taskStageIds:
  string[] = []`: válido si `manualClientIds.length>0` O `manualContacts.length>0` O
  `taskStageIds.length>0` O segmento con criterio real; se rechaza (`UnfilteredSegmentError`) SOLO
  si los CUATRO están vacíos.
  - Test (extiende `src/__tests__/application/messaging/assertHasRecipients.test.ts`): sin segmento
    filtrado, sin manual, sin csv, con `taskStageIds: ['stageA']` → NO lanza (campaña
    solo-tarea válida). Los 3 casos existentes (manual-only/csv-only/segmento-only) siguen verdes
    SIN editar sus aserciones (no-regresión).
- [ ] **Gate B4**: suites 4.2/4.3/4.5 verdes + `assertHasRecipients.test.ts` existente sin editar
  aserciones previas; `tsc --noEmit` limpio.

## Batch 5 — Branch `task` en `resolveCombinedRecipients` + snapshot inmutable (TASK-3..TASK-9, D3 cap, D4, D7)

- [ ] **5.1** `RecipientSource` (`resolveCombinedRecipients.ts:44`) gana `'task'` →
  `'segment'|'manual'|'csv'|'task'`. `CombinedRecipientsResult` gana `taskSkipped:
  RecipientSkipCounts` + `noCustomerCount: number`. `resolveCombinedRecipients` gana params
  `taskStageIds: string[]` (requerido, molde `manualContacts`) + `taskRecipientSource?:
  TaskRecipientSource` (opcional, molde `manualRecipientSource`) + `MAX_TASK_STATE_RECIPIENTS =
  10000` (exportado, molde `MAX_MANUAL_RECIPIENTS`).
- [ ] **5.2** **Reordenamiento estructural requerido** (guía concreta de implementación, no está
  al detalle de línea en el design): la resolución+hidratación de `task` NO puede vivir en
  "sección 3" en paralelo al CSV — necesita `byClientId`/`seenPhones` **YA poblados** por los
  `admit()` de segmento+manual+csv (D4 "filtra los ya presentes en byClientId"), y esos solo están
  completos al FINAL de los 3 loops de unión actuales (`:295-321`). Por eso el bloque `task` se
  inserta como un **4to paso DESPUÉS** de esos 3 loops (no como una 4ta "sección de resolución"
  temprana): fetch (`taskRecipientSource.listClientIdsByOpenTaskStages`, await) → cap check → filtra
  contra `byClientId` (silencioso, mismo criterio que el overlap manual-vs-segmento, `:196`) → hidrata
  el resto vía `manualRecipientSource.findRecipientCandidatesByIds` (CERO port nuevo, D2) →
  `resolveRecipients` (compliance dentro del set task: opt-out/teléfono-inválido/dedup-interno) →
  loop `admit()` propio que además chequea `seenPhones` (dedup cross-source por teléfono, molde CSV
  `:307-321`) → `taskSkipped.duplicatePhone++` en el dup, si no `admit({...c, source:'task'})`.
  `noCustomerCount = taskStageIds.length>0 ? await taskRecipientSource.countOpenTasksWithoutCustomer(taskStageIds)
  : 0` (independiente, no es un skip de teléfono).
  - RED+GREEN, extiende `src/__tests__/application/messaging/resolveCombinedRecipients.test.ts` (NO
    tocar aserciones existentes de segmento/manual/csv — solo AGREGAR):
    - Cliente con 5 tareas abiertas en 2 stages tildados → aparece UNA vez en `resolved` (TASK-3
      scenario 1, delegado al in-memory de 2.4 pero verificado en el seam completo acá).
    - Stage mapeado sin tareas abiertas → 0 por ese origen, sin error (TASK-3 scenario 2).
    - Tarea `kind:'network'`/`customerId:null` en stage tildado → NO genera recipient;
      `noCustomerCount` refleja el conteo exacto (TASK-3 scenario 3).
    - Tarea cerrada (única del cliente en el stage) → cliente NO entra (TASK-3 scenario 4).
    - Set distinct > `MAX_TASK_STATE_RECIPIENTS` (10000) → `TooManyTaskStateRecipientsError` ANTES
      de hidratar (TASK-4 scenario, cap enforcement — el error se DECLARÓ en 4.1, se LANZA acá).
    - Cliente resuelto por tarea sin teléfono válido → excluido, `taskExcludedDetail` con
      `telefono_invalido` (TASK-5 scenario 1).
    - Cliente opt-out resuelto por tarea → excluido con `opt_out` (TASK-5 scenario 2).
    - Cliente en segmento Y con tarea en stage tildado → aparece UNA vez con `source:'segment'`
      (task NO lo posee — TASK-6 scenario "gana el label de segmento").
    - Cliente ÚNICAMENTE por tarea → `source:'task'` (TASK-6 scenario 2).
    - `taskSkipped` (opt-out/dup/invalid) calculado SEPARADO de segmento/manual/csv; preview con 2
      válidos + 1 opt-out + 3 tareas de red sin cliente → `count` incluye los 2, `taskSkipped.optedOut:
      1`, `noCustomerCount: 3` (TASK-7 scenario).
    - Regresión: TODAS las suites existentes de SEG/MAN/CSV en este archivo siguen verdes SIN editar
      una sola aserción (`taskStageIds: []` por default en los tests viejos → comportamiento
      byte-idéntico, TASK-1 scenario "no-regresión").
- [ ] **5.3** `PreviewCampaignSegment`/`ListSegmentRecipients`/`CreateCampaign` — inyectan
  `taskRecipientSource?: TaskRecipientSource` + `taskStageConfigRepo?:
  TaskStageRecipientConfigRepository` (2 args OPCIONALES nuevos AL FINAL de cada constructor, molde
  `manualRecipientSource`, no rompen la aridad de tests ya verdes). Cada `execute`: llama
  `assertHasRecipients(..., taskStageIds)` (4.5) → `await assertTaskStagesEligible(taskStageIds,
  taskStageConfigRepo)` (4.2, lanza 422 ANTES de resolver clientes — satisface TASK-2 en el punto de
  ejecución, aunque el guard vive en un helper separado del resolver, ver desvío #4) → pasa
  `taskStageIds` + `taskRecipientSource` a `resolveCombinedRecipients`. `PreviewCampaignSegment`/
  `ListSegmentRecipients` suman `taskSkipped` al `skipped` de salida (mismo patrón
  `segmentSkipped+manualSkipped+csvSkipped`) y exponen `noCustomerCount`.
  - RED+GREEN, extiende `PreviewCampaignSegment.test.ts`/`ListSegmentRecipients.test.ts` (buscar o
    crear si no existe)/`CreateCampaign.test.ts`:
    - `taskStageIds: ['stageA']` no mapeado → 422 `TASK_STAGE_NOT_ELIGIBLE` propagado desde el use
      case (TASK-2, seam completo).
    - `manualClientIds:['c1']` + `taskStageIds:['stageA']` (mapeado, c2 con tarea abierta) → crea 2
      recipients: c1 `source:'manual'`, c2 `source:'task'` (TASK-1 scenario "combinación con
      manual").
- [ ] **5.4** Snapshot inmutable (TASK-8, D7) — `CreateCampaign` materializa `resolved` (incl. los de
  `source:'task'`) como `CampaignRecipient` con `clientId` SIEMPRE seteado (camino "vinculado",
  molde `contactName: null` para task — nunca crudo). `SendCampaign` NO CAMBIA (ya opera sobre
  `CampaignRecipient.clientId != null`).
  - RED+GREEN, extiende `CreateCampaign.test.ts` (crea) + un test de integración corto (puede vivir
    en el mismo archivo o en `resolveCombinedRecipients.test.ts` si `SendCampaign` no es fácil de
    tocar sin su propio harness): campaña creada con `taskStageIds:['stageA']` → el admin desmapea
    `stageA` de la config DESPUÉS del create (via el in-memory config repo) → los recipients YA
    materializados no cambian, ninguna re-resolución ocurre (TASK-8 scenario 1). Ídem cerrando la
    tarea del cliente DESPUÉS del create (TASK-8 scenario 2) — ambos verificables re-leyendo
    `campaignRepo` sin volver a invocar `CreateCampaign`.
- [ ] **5.5** bulk-granular-perms automático (TASK-9, D5 "sin código nuevo") — test que confirma que
  un cliente `status:'blocked'` resuelto ÚNICAMENTE por `taskStageIds`, con un operador sin
  `messaging.bulk_blocked`, dispara `BulkRecipientsNotPermittedError` (403) al crear — SIN tocar
  `forbiddenBulkTargets`/`CreateCampaign.ts:93-101` (extiende `CreateCampaign.test.ts`, confirma que
  el mecanismo existente ya cubre `source:'task'` porque lee `status` del candidato hidratado, no el
  `source`).
- [ ] **Gate B5**: `resolveCombinedRecipients.test.ts` + los 3 use-case tests, verdes. Suites SEG/MAN/
  CSV preexistentes verdes SIN una sola aserción editada (cero regresión, D9).

## Batch 6 — Wiring `app.ts` + composition-root (D6, D9)

- [ ] **6.1** RED — extender `src/__tests__/infrastructure/messaging-bulk-composition.test.ts`
  (bootea `createApp()` real): afirma que `PreviewCampaignSegment`/`ListSegmentRecipients`/
  `CreateCampaign` reciben una instancia de `TaskRecipientSource` Y de
  `TaskStageRecipientConfigRepository` (molde de las aserciones de 6.1 en `chatwoot-hub-sendpath`) —
  sin esto el 5to dominio queda cableado a la nada en prod (lección W6, ya citada en el propio
  design).
- [ ] **6.2** RED — nuevo `src/__tests__/infrastructure/task-stage-config-composition.test.ts` (molde
  `nocBroadcast.routes.test.ts`): bootea `createApp()`, verifica que `GET/PUT
  /api/messaging/config/task-stages` responden (no 404) y que los gates `messaging.read`/
  `messaging.manage` están aplicados.
- [ ] **6.3** GREEN — `app.ts`, bloque bulk (~`:3051-3077`, molde del bloque ya existente de esta
  sección): instancia `const taskStageConfigRepo = new PrismaTaskStageRecipientConfigRepository()` +
  `const taskRecipientSource = new PrismaTaskRecipientSource()` (scope-local al bloque bulk, mismo
  precedente que `chatwootGatewayForBulk`/`featureFlagRepoForBulk` — NO comparte variable con el
  bloque de config nuevo abajo, anti-interleave); inyecta ambos como args nuevos AL FINAL de
  `PreviewCampaignSegment`/`ListSegmentRecipients`/`CreateCampaign` (molde `customerAdapter` como
  `ManualRecipientSource`, misma instancia reusada donde aplica).
- [ ] **6.4** GREEN — `app.ts`, bloque NUEVO self-contained (molde exacto del bloque N1
  `:3131-3151`, montado en un prefijo MÁS específico que `/api/messaging` — mismo fall-through que
  `/noc-broadcast`): `const taskStageConfigRepoForRoute = new PrismaTaskStageRecipientConfigRepository()`
  (puede ser la MISMA instancia de 6.3 si se saca del scope del bloque bulk hacia arriba, o una
  nueva — cualquiera es válida porque el repo es stateless; documentar la elección en un comentario,
  molde `n3NocBroadcastConfigRepo` vs el bloque N1 original que SÍ reusa variable). `app.use(
  '/api/messaging/config/task-stages', createTaskStageConfigRouter(authAdapter, { read:
  requirePerm('messaging','read'), manage: requirePerm('messaging','manage') }, new
  GetTaskStageRecipientConfig(repo), new UpdateTaskStageRecipientConfig(repo)))`.
- [ ] **Gate B6**: `npm test` completo BE verde. NO `npm run build` (regla del repo — CLAUDE.md).

## Batch F (reservado) — Fix wave post-review adversarial

Sin tasks pre-definidas — se completa tras el review adversarial de B1-B6, molde `chatwoot-hub-
sendpath` Batch F (severidad ALTO/MEDIO/LOW por finding).

---

## Sección FE — repo `ipnext-frontend` (apply DESPUÉS del BE verde, B1-B6 + Batch F)

Archivos reales verificados en `ipnext-frontend`: `src/components/settings/NocBroadcastCard.tsx`,
`src/pages/whatsapp/WhatsappSettingsPage.tsx`, `src/pages/whatsapp/BulkMessagingPage/components/
composer/CampaignComposer.tsx` (tabs actuales: `'segment'|'network'|'manual'|'csv'|'numbers'`, 5 —
`'task'` es el 6to), `src/hooks/useWorkflows.ts` (YA existe, gate `scheduling.read`).

- [ ] **FE-1** `TaskStageConfigCard` en `WhatsappSettingsPage` (molde `NocBroadcastCard.tsx`):
  multi-select agrupado por Workflow, poblado por `useWorkflows()` (gate `scheduling.read`) + `GET
  /config/task-stages` (gate `messaging.read`); guarda con `PUT` (gate `messaging.manage`). 4 ramas
  de estado: cargando / catálogo de workflows vacío / sin `scheduling.read` (hint, NO 403 opaco) /
  cargado con el mapeo actual tildado. Test: `src/__tests__/whatsapp/TaskStageConfigCard.test.tsx`
  (molde `NocBroadcastCard.test.tsx`) — cubre las 4 ramas + guardado exitoso + error de guardado.
- [ ] **FE-2** Tab `'task'` en `CampaignComposer` (`RecipientsTabId` gana `'task'`, 6to valor):
  checkboxes SOLO de los stages MAPEADOS (`GET /config/task-stages`), el operador tilda un subset →
  payload `taskStageIds`. **Config vacía → tab deshabilitado** con hint ("Configurá estados de tarea
  en Ajustes → WhatsApp"). `mountMode=all` (molde de los otros tabs, estado persiste entre cambios de
  tab). Test: extiende `src/__tests__/whatsapp/composer/CampaignComposer.tabs.test.tsx` (nuevo tab
  visible/deshabilitado según config) + un test de payload en `CampaignComposer.test.tsx`
  (`taskStageIds` viaja tildado).
- [ ] **FE-3** `PreviewModal` (ya paginado) suma `source:'task'` en counts/excluidos + chip
  `noCustomerCount` — sin rediseño, extiende el mapeo de fuentes existente (buscar dónde
  `'segment'|'manual'|'csv'` ya se renderizan como badges/labels y agregar `'task'`). Test: extiende
  el test existente del modal con un caso `source:'task'` + `noCustomerCount > 0`.

---

## Coordinación de merges (D10)

Este change toca `resolveCombinedRecipients` (unión `RecipientSource`, branch APPEND, params
`taskStageIds`/`taskRecipientSource`, `noCustomerCount`) y `CampaignComposer` — MISMOS archivos que
`campaign-chatwoot-label` (en vuelo) y `bulk-csv-recipients` (base, ya mergeado según
`messagingBulk.routes.ts`/`resolveCombinedRecipients.ts` verificados en este worktree). Todo ADITIVO
(append, no reescritura).

- [ ] Si `campaign-chatwoot-label` aterriza en `main` ANTES que este change: rebasar sobre él antes de
  abrir PR. Puntos de colisión esperados: (a) el `type RecipientSource` union + las uniones `source`
  de los DTOs (agregar `'task'` al final, nunca reordenar los existentes); (b) el array
  `RecipientsTabId`/tabs del composer FE (agregar `'task'` al final); (c) el bloque de wiring
  self-contained en `app.ts` (el bloque de config nuevo es propio, NO interleava con el bloque de
  label si ese change también toca `app.ts`).
- [ ] Las aserciones existentes de SEG/MAN/CSV (BE) y de los tabs segment/network/manual/csv/numbers
  (FE) NO se editan en este change — si un rebase las toca, es señal de conflicto real a resolver
  manualmente, no de un merge automático correcto.

---

## Riesgos / desvíos detectados en esta fase (spec ↔ design)

- **#1 — RECONCILIACIÓN OBLIGADA (RBAC bulk-sin-read)**: el `design.md` (D6) deja esto como "Open
  Question"/"riesgo residual" pidiendo verificar el seed y potencialmente ampliar el gate del GET a
  `messaging.read ∨ messaging.bulk`. El **spec** (TSC-3) YA lo resolvió contra el seed real:
  `20260904000100_messaging_permissions` + `20260908000100_messaging_bulk_permissions` conceden
  AMBOS pares (`read+send`, `bulk+templates`) a los MISMOS DOS roles seedeados
  (`super_admin`/`administrador`) — **ningún rol seedeado tiene hoy `bulk` sin `read`**. El caso de
  un rol custom mal configurado (posible vía el matrix RBAC dinámico existente) se resuelve
  OPERATIVAMENTE otorgándole `messaging.read`, NO ampliando el gate. **Los tasks de B3 implementan
  la resolución del SPEC** (gate simple `messaging.read`, sin soporte OR en `requirePermission`) —
  el apply/verify **NO debe reabrir** esta decisión ni agregar la variante any-of.
- **#2 — Atomicidad de `UpdateTaskStageRecipientConfig` (TSC-4)**: el spec dice "validar que TODOS
  los stageIds correspondan a un Stage EXISTENTE **ANTES** de reemplazar". El design (D2) resuelve
  esto vía transacción atómica en el ADAPTER (`$transaction([deleteMany, createMany])`, rollback
  automático si `createMany` falla por FK P2003) — **no** vía un pre-chequeo de existencia separado
  en el use case. Ambos caminos satisfacen el requirement observable ("s1 no se aplica solo, la
  config previa no cambia"); B3.2 sigue el camino del design (más barato, sin query extra) — el
  apply no debe agregar una validación de existencia redundante en el use case.
- **#3 — Dos archivos de errores, no uno**: el design lista "3 errores nuevos" en el File Changes
  table apuntando a `messaging-bulk.ts`, pero D2 también menciona `TaskStageNotFoundError` (el que
  traduce el P2003 del adapter de config). Ese 4to error **NO** pertenece al delta `messaging-bulk`
  (es de la capability nueva `messaging-task-stage-config`) — B2.7 lo crea en un archivo separado
  (`domain/errors/messaging-task-stage-config.ts`, molde precedente `domain/errors/nocBroadcast.ts`)
  y B4.1 crea los otros 3 (`TaskStageNotEligibleError`/`TooManyTaskStateRecipientsError`/
  `InvalidTaskStageIdsError`) en `messaging-bulk.ts`. Evita mezclar las dos capabilities en un mismo
  archivo de errores.
- **#4 — Elegibilidad: guard en el use case, NO dentro del resolver**: TASK-2 (spec) dice literal
  "`resolveCombinedRecipients` MUST validar...". El design (D3) decide DELIBERADAMENTE que esa
  validación viva en `assertTaskStagesEligible` (helper invocado por los 3 use cases ANTES de
  llamar a `resolveCombinedRecipients`), no dentro de la función del resolver — para no acoplar el
  resolver compartido a un port de config-CRUD que no le corresponde. El requirement observable del
  spec (422 ANTES de resolver clientes) se cumple igual porque el guard corre ANTES en la secuencia
  de ejecución del use case. B4.2/B5.3 siguen el design; `sdd-verify` debe validar el
  **comportamiento** (422 antes de tocar `TaskRecipientSource`), no la ubicación literal del código.
- **#5 — Paridad GET distinta de `manualContacts`/`manualClientIds`**: `taskStageIds` SÍ se agrega a
  los endpoints GET de deep-link (`/segment/preview`, `/segment/recipients`) vía el mismo helper
  `queryStatuses` que usa `statuses` — a diferencia de `manualClientIds`/`manualContacts`, que
  NUNCA viajaron por query (payload arbitrario/límites de URL, DET-3). Es coherente: `taskStageIds`
  es una lista corta de ids de catálogo (como `statuses`), no una lista hand-curated de clientIds ni
  un CSV. B4.3 lo implementa explícitamente para que `sdd-verify` no lo confunda con un olvido.
