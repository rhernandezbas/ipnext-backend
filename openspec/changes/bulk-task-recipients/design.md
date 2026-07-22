# Design — bulk-task-recipients

5to dominio de destinatarios del Bulk WhatsApp: **Tarea** (clientes con ≥1 tarea ABIERTA en un `Stage`
mapeado). Decisiones D1..D12 con evidencia del código real (`file:line` del worktree
`bulk-task-recipients-be`). Molde replicado: `bulk-csv-recipients` (D1-D12) + `nocBroadcast` (config CRUD).
NO se re-litiga la proposal (§ Decisiones de producto ya tomadas).

---

## §0. Estado actual (evidencia)

- **Estado de tarea = `ScheduledTask.stageId`** FK a `Stage` `onDelete: Restrict` (`schema.prisma:1266-1267`),
  NO enum. Ciclo de vida = `generalStatus String @default("open")` (`:1337`, single source of truth:
  `'open'|'closed'|'dismissed'`) — **es el campo honesto a filtrar, NO `isClosed`**. Cliente = `customerId
  String?` FK directa a `Client` `onDelete:SetNull` (`:1286-1287`); tareas de red (`kind:'network'`, `:1356`)
  tienen `customerId` null. Índices existentes: `@@index([stageId])` (`:1406`), `@@index([customerId])`
  (`:1410`) — NO hay compuesto.
  > **Hallazgo (fix wave, F1, HIGH)**: la primera versión de este design (y de la spec/código/índice que
  > siguieron) filtraba por `isClosed Boolean @default(false)` (`:1339`, derivado de `generalStatus`,
  > sincronizado en cada write — PERO una tarea `generalStatus:'dismissed'` (descartada) tiene
  > `isClosed === false` TAMBIÉN, `messaging.ts:227-228`). Filtrar por `isClosed` dejaba pasar tareas
  > DESCARTADAS como si fueran destinatarios válidos. El error se propagó explore → spec → design →
  > código → índice; corregido EN EL LUGAR en la fix wave (el batch nunca llegó a prod ni a main). El
  > único otro camino de "tareas abiertas" del repo, `PrismaFiberAutoProvisionTaskRepository.ts:16`, ya
  > usaba `generalStatus:'open'` — molde que este change debió seguir desde el principio.
- **`Stage`** (`:522-541`): `id`, `workflowId` FK `Workflow` `onDelete:Cascade`, `name`, `code`, `category`
  (enum `StageCategory`), `order`, `color`. `@@unique([workflowId, code])`.
- **`resolveCombinedRecipients`** (`resolveCombinedRecipients.ts`) es el orquestador COMPARTIDO por
  `PreviewCampaignSegment`/`ListSegmentRecipients`/`CreateCampaign`. Cada dominio: su fuente, su
  `xxxSkipped: RecipientSkipCounts`, su `xxxExcludedDetail`, entra a la unión con precedencia fija vía
  `admit()` (dedup por `clientId` Y `phoneNormalized`, `:289-321`). Las validaciones fail-loud + los caps de
  cada dominio viven DENTRO de este archivo (caps `:145-151`, fail-loud manual `:185-201`).
  `RecipientSource = 'segment'|'manual'|'csv'` (`:44`).
- **`CampaignRecipient.clientId` ya es nullable** (bulk-csv-recipients, `schema.prisma:3312`) → CERO migración
  en Campaign/CampaignRecipient. Un recipient por tarea SIEMPRE tiene `clientId` (camino "vinculado").
- **Config molde**: `NocBroadcastConfig` singleton (`schema.prisma:2308`) + router factory
  (`nocBroadcast.routes.ts:30-76`) + wiring self-contained (`app.ts:3138-3151`, gates
  `requirePerm('messaging','read'|'manage')`). `GET /workflows` (catálogo de stages) ya existe con gate
  `scheduling.read` (`workflows.routes.ts:87-94`); `ListWorkflows` devuelve `Workflow[]` con `stages`
  anidados y ordenados (`ListWorkflows.ts:9-13`).

---

## D1 — Prisma: tabla `WhatsappTaskStageRecipientConfig` (1 fila por stage) + índice compuesto

**Tabla nueva** (NO singleton — es un set de N stages mapeados):

```prisma
model WhatsappTaskStageRecipientConfig {
  id        String   @id @default(uuid())
  stageId   String   @unique
  stage     Stage    @relation(fields: [stageId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())
}
```

+ back-relation en `Stage` (aditiva, columna virtual): `whatsappTaskStageRecipientConfig WhatsappTaskStageRecipientConfig?`.

**Elegida sobre `String[]` crudo** (proposal §1a): FK real → imposible mapear un stage inexistente, y borrar un
Stage limpia la config vía `onDelete:Cascade` (coherente con el fail-loud del feature). `@unique` en `stageId`
= idempotencia del mapeo + índice implícito para la lectura de elegibilidad.

**Índice de resolución — `@@index([stageId, generalStatus, customerId])` sobre `ScheduledTask`.**

> **fix wave (F1, HIGH)**: el leaf de acotamiento es `generalStatus`, NO `isClosed` (ver Hallazgo en §0) —
> `isClosed` no distingue `'dismissed'` de `'open'`, así que un índice sobre ese campo cubriría el predicado
> EQUIVOCADO (dejaría pasar tareas descartadas igual, con o sin índice). Reescrito en el lugar: la migración
> aditiva ya existente (`20261019000000_task_stage_recipient_config`) nunca llegó a prod ni a main.

| Opción | Tradeoff | Decisión |
|---|---|---|
| `(stageId, isClosed)` | filtra el campo EQUIVOCADO (no distingue `dismissed` de `open`) además de requerir heap-fetch para proyectar `customerId` | descartado |
| `(stageId, generalStatus, customerId)` | **covering**: index-only scan para el DISTINCT(customerId) Y para el count de `customerId IS NULL`; leaf `customerId` sirve la proyección y ambos predicados (`not null` / `is null` son rangos contiguos en el btree); `generalStatus='open'` es el predicado REAL que ejecuta el adapter | **ELEGIDO** |

Cardinalidad: `stageId` (equality, el `IN` = N seeks selectivos) → `generalStatus='open'` (acota a lo
vigente, excluye `closed` Y `dismissed`) → `customerId` como leaf cubre `distinct` y `count(null)`. Justifica
el riesgo citado (un stage con miles de tareas históricas abiertas). El `@@index([stageId])` existente se
CONSERVA (lo usan otros paths de scheduling).

**Migración aditiva** vía `npm run prisma:migrate` (`CREATE TABLE` + FK + `CREATE INDEX`). Sin backfill, sin
editar SQL a mano (CLAUDE.md).

## D2 — Dos ports narrow SEPARADOS (disciplina ISP)

**Config CRUD** — `domain/ports/TaskStageRecipientConfigRepository.ts`:

```ts
export interface MappedStage {
  stageId: string; stageName: string; stageCode: string;
  color: string | null; workflowId: string; workflowName: string;
}
export interface TaskStageRecipientConfigRepository {
  listMappedStageIds(): Promise<string[]>;            // set de elegibilidad (barato)
  getMappedStages(): Promise<MappedStage[]>;          // hidratado para card + tab + DTO
  replaceMappedStages(stageIds: string[]): Promise<void>; // replace-set (NO append)
}
```

Adapter Prisma (`PrismaTaskStageRecipientConfigRepository.ts`, molde
`PrismaNocBroadcastConfigRepository`): `getMappedStages` = `findMany({ include:{ stage:{ include:{ workflow }}}})`;
`replaceMappedStages` = `$transaction([deleteMany({}), createMany({ data: stageIds.map(stageId=>({stageId})) })])`
— **atómico**: un `stageId` inexistente hace fallar el `createMany` con FK P2003 → el adapter lo traduce a
`TaskStageNotFoundError` (422) y la transacción hace rollback (config preservada). In-memory
(`InMemoryTaskStageRecipientConfigRepository`) espejo: un catálogo fixture `stageId→{name,code,color,workflow}`
+ un `Set` mapeado; `replaceMappedStages` valida contra el catálogo (espeja la FK).

**Resolución** — `domain/ports/TaskRecipientSource.ts` (SEPARADO, no cuelga de `CustomerRepository`):

```ts
export interface TaskRecipientSource {
  listClientIdsByOpenTaskStages(stageIds: string[]): Promise<string[]>; // DISTINCT customerId
  countOpenTasksWithoutCustomer(stageIds: string[]): Promise<number>;   // chip honesto
}
```

Adapter Prisma (`PrismaTaskRecipientSource.ts`, o método en `PrismaSchedulingRepository`):
`scheduledTask.findMany({ where:{ stageId:{in:stageIds}, customerId:{not:null}, generalStatus:'open' }, select:{customerId:true}, distinct:['customerId'] })` → map `c.customerId`;
count `where:{ stageId:{in}, customerId:null, generalStatus:'open' }` (fix wave F1 — NUNCA `isClosed`, ver
Hallazgo §0). In-memory espejo sobre un array de tareas fixture (`TaskFixture` incluye `generalStatus`).

**Hidratación reusada, CERO port nuevo**: los clientIds resueltos se hidratan por
`ManualRecipientSource.findRecipientCandidatesByIds` (`CustomerRepository.ts:186-196`, misma instancia
`customerAdapter`) → candidatos con `name/phone/status/balanceDue/whatsappOptOutAt`, mismo derivador E164
(`toWhatsAppE164`/`normalizePhone`) que segmento/manual. Cero lógica de teléfono nueva.

## D3 — Elegibilidad en el use case; cap en el resolver (split defendible)

- **Elegibilidad (subset ⊆ mapeados)** = autoridad CROSS-dominio (la config gobierna qué puede tocar el
  resolver) → vive con los otros guards de pre-vuelo del use case (`assertHasRecipients`), NO en el resolver
  (meterle el port de config-CRUD al resolver compartido lo acopla a un concern que no le toca). Helper
  compartido `assertTaskStagesEligible(taskStageIds, configRepo)` (molde `assertHasRecipients.ts:16-24`):
  si `taskStageIds` no vacío → `mapped = await configRepo.listMappedStageIds()`; si algún id ∉ mapped →
  `TaskStageNotEligibleError(ineligibles)` → **422**. Lo invocan `PreviewCampaignSegment`/`ListSegmentRecipients`/
  `CreateCampaign` (inyectan `TaskStageRecipientConfigRepository`, opcional, molde `manualRecipientSource`).
  El BE es la AUTORIDAD aunque el composer solo ofrezca mapeados (defensa en profundidad).
- **Cap (`MAX_TASK_STATE_RECIPIENTS=10000`)** = baranda sobre el SET de salida (distinct resuelto), que SOLO
  el resolver ve → vive DENTRO de `resolveCombinedRecipients` (consistente con `MAX_MANUAL_*`,
  `resolveCombinedRecipients.ts:25/34/145-151`). Exceso → `TooManyTaskStateRecipientsError(n,max)` → **422**
  accionable ("acotá los estados"). 10000 = doble del cap manual/csv (5000): el universo es computado, no curado.

## D4 — Branch `task` en `resolveCombinedRecipients` (APPEND al final)

`RecipientSource` gana `'task'` (`:44`). `resolveCombinedRecipients` gana params
`taskStageIds: string[]` + `taskRecipientSource?: TaskRecipientSource`. Orden en la unión: **segmento > manual
> csv > task** (task APPEND después del loop CSV `:307-321` → cero regresión en orden/labels existentes; un
cliente ya admitido por otra fuente conserva su source, task solo "posee" a los resueltos ÚNICAMENTE por
tarea). Se parece al branch `manual` (`:182-201`, siempre hay `clientId`), no al de CSV:

1. `taskClientIds = await taskRecipientSource.listClientIdsByOpenTaskStages(taskStageIds)` (distinct).
2. **Cap**: `taskClientIds.length > MAX_TASK_STATE_RECIPIENTS` → throw (D3).
3. Filtra los ya presentes en `byClientId` (overlap seg∪manual∪csv — conservan su source por precedencia).
4. Hidrata el resto con `findRecipientCandidatesByIds` → `resolveRecipients` (opt-out excluido, teléfono
   inválido descartado, dedup por teléfono dentro del set) → `taskSkipped: RecipientSkipCounts`
   (optedOut/duplicatePhone/invalidPhone) + `taskExcludedDetail` (`toExcludedDetail(e,'task')`, `:389-398`).
5. `admit(..., source:'task')` con dedup cross-source por `phoneNormalized` (un dup contra la unión →
   `taskSkipped.duplicatePhone`, entra a `excludedDetail` con `reason:'duplicado', source:'task'`).
6. `noCustomerCount = await taskRecipientSource.countOpenTasksWithoutCustomer(taskStageIds)` — chip agregado
   "N tareas de red sin cliente omitidas" (NO es un skip de teléfono; campo aparte).

`CombinedRecipientsResult` gana `taskSkipped` + `noCustomerCount`; `excludedDetail` incluye las entradas
`source:'task'` (ya ordenado por `sortExcluded`, `:373-387`). `PreviewCampaignSegment`/`ListSegmentRecipients`
suman `taskSkipped` a `skipped` (mismo patrón `:61-65`/`:91-95`) y exponen `noCustomerCount` en su output.

## D5 — Wire: `taskStageIds`, parser fail-loud, errores tipados, statusMap

- **Parser** `toTaskStageIds(raw)` en `messagingBulk.routes.ts` (molde `toManualClientIds:77-88`): ausente →
  `[]`; no-array o item no-string → `InvalidTaskStageIdsError` (`VALIDATION_ERROR` → 400).
- **DTOs** (`messaging-bulk.dto.ts`): `taskStageIds?: string[]` en `PreviewSegmentInput` (`:59-87`, lo hereda
  `ListSegmentRecipientsInput` `:139`) y `CreateCampaignInput` (`:189-227`). Las uniones `source` de
  `SegmentRecipientItemDto` (`:151`) y `ExcludedRecipientItemDto` (`:164`) ganan `'task'`. `PreviewSegmentOutput`
  (`:102-121`) y `ListSegmentRecipientsOutput` (`:178-185`) ganan `noCustomerCount: number`.
- **Handlers** (`messagingBulk.routes.ts`): `taskStageIds: toTaskStageIds(body?.['taskStageIds'])` en POST
  `/segment/preview` (`:215-225`), POST `/segment/recipients` (`:279-290`), POST `/campaigns` (`:339-358`);
  GET variantes vía `queryStatuses(req.query['taskStageIds'])` (molde `:62-65`, paridad de deep-link).
  `assertHasRecipients` (`assertHasRecipients.ts:16-24`) gana 4to componente: `taskStageIds.length>0`.
- **Errores nuevos** (`domain/errors/messaging-bulk.ts`): `TaskStageNotEligibleError` (`TASK_STAGE_NOT_ELIGIBLE`,
  lleva `ineligibleStageIds`), `TooManyTaskStateRecipientsError` (`TOO_MANY_TASK_STATE_RECIPIENTS`, `received/max`),
  `InvalidTaskStageIdsError` (`VALIDATION_ERROR`). **statusMap** (`errorHandler.ts:11`, molde `:204/215/219`):
  `TASK_STAGE_NOT_ELIGIBLE:422`, `TOO_MANY_TASK_STATE_RECIPIENTS:422`.
- **bulk-granular-perms**: un cliente por tarea entra AUTOMÁTICO al recheck por `status`
  (`CreateCampaign.ts:107-110`, el candidato hidratado trae `status`). Sin código nuevo.

## D6 — Config CRUD (`/api/messaging/config/task-stages`)

Router `createTaskStageConfigRouter` (molde `nocBroadcast.routes.ts:30-76`) montado en
`/api/messaging/config/task-stages` (prefijo MÁS específico que `/api/messaging`, registrado DESPUÉS → mismo
fall-through que `/noc-broadcast`, `app.ts:3131-3151`):

- `GET /` → `GetTaskStageRecipientConfig.execute()` → `{ stages: MappedStage[] }`. **Gate `messaging.read`**
  (lo leen la card de Ajustes Y el composer para pintar el tab).
- `PUT /` → body `{ stageIds: string[] }`, Zod `safeParse` → 400 `VALIDATION_ERROR` (molde
  `nocBroadcast.routes.ts:51-62`) → `UpdateTaskStageRecipientConfig.execute({stageIds})` → replace-set →
  devuelve `{ stages }`. **Gate `messaging.manage`** (mismo permiso supervisor que canned-responses/noc-broadcast).

Use cases `GetTaskStageRecipientConfig`/`UpdateTaskStageRecipientConfig` (molde `GetNocBroadcastConfig`/
`UpdateNocBroadcastConfig`), dependen solo de `TaskStageRecipientConfigRepository`. Wiring self-contained en
`app.ts` (bloque nuevo, molde `:3138-3151`): `const repo = new PrismaTaskStageRecipientConfigRepository()`.

**RBAC — dos capas**: (1) route gate (`requirePerm`); (2) re-validación de elegibilidad en el resolver-caller
(D3) — el FE ofrece solo mapeados, el BE re-valida (autoridad). **Riesgo (proposal §6)**: si algún rol tiene
`messaging.bulk` sin `messaging.read`, el composer no puede leer el GET → el spec/tasks debe verificar el seed
RBAC; si aplica, ampliar el gate del GET a `messaging.read ∨ messaging.bulk`. Se deja como Open Question.

## D7 — Snapshot materializado inmutable (invariante declarado)

Los clientIds distinct resueltos se congelan como `CampaignRecipient` al `CreateCampaign`
(`CreateCampaign.ts:127-138`, `clientId` siempre seteado — nunca `contactName`). **El envío JAMÁS re-resuelve**:
si el mapeo cambia, o una tarea se cierra, entre create y send → sin efecto (snapshot frozen). `SendCampaign` NO
cambia (recipients `clientId != null`, camino vinculado normal). CERO migración en Campaign/CampaignRecipient.

## D8 — FE (plan, sobre el BE ya verde)

- **Card "Destinatarios por estado de tarea"** en `WhatsappSettingsPage` (molde `NocBroadcastCard`): multi-select
  agrupado por Workflow, poblado por `useWorkflows()` (**gate FE `scheduling.read`**, `ListWorkflows` ya trae
  stages anidados) + el mapeo actual de `GET /config/task-stages` (`messaging.read`); guarda con `PUT`
  (`messaging.manage`). **4 ramas de estado**: cargando / catálogo vacío / sin `scheduling.read` (hint "necesitás
  permiso de scheduling para elegir estados", NO 403 opaco) / cargado. Select/checklist PROPIO (NUNCA nativo).
- **Tab "Tarea"** en `CampaignComposer` (6to tab UI, 4to dominio de wire): checkboxes de los stages MAPEADOS
  (`GET /config/task-stages`), el operador TILDA un subset → payload `taskStageIds`. **Config vacía → tab
  DESHABILITADO con hint** ("Configurá estados de tarea en Ajustes → WhatsApp"). Chips honestos + el preview
  cuenta la UNIÓN + chip `noCustomerCount`. `mountMode=all` como los otros tabs (estado del tab persiste entre
  cambios de tab).
- **PreviewModal** (ya paginado) suma la fuente `task` en counts/excluidos + el chip `noCustomerCount`, sin rediseño.

## D9 — Test plan (seam completo)

| Capa | Qué | Cómo |
|---|---|---|
| Use case (resolve) | subset inválido → 422; dedup precedencia (cliente task+segmento conserva `segment`); cap 10000 → 422; `taskSkipped` buckets; `noCustomerCount`; una tarea cerrada NO entra | in-memory (`InMemoryTaskRecipientSource` + `InMemoryTaskStageRecipientConfigRepository`), NO mock Prisma |
| Use case (create) | snapshot inmutable: cambiar mapeo / cerrar tarea post-create no altera los recipients frozen | in-memory |
| Use case (config) | `getMappedStages` hidrata; `replaceMappedStages` replace-set; stageId desconocido → rechazado (espeja FK) | in-memory |
| Cascade | borrar Stage → fila de config eliminada | in-memory mirror + nota de migración (`onDelete:Cascade`) |
| Ruta | GET/PUT `/config/task-stages`: 403 sin permiso, PUT malformado → 400; wire en los 3 existentes: `taskStageIds` parseado, no-elegible → 422, malformado → 400 | supertest, repos in-memory |
| Composition-root | extender `messaging-bulk-composition.test.ts` (nuevos ports wired) + nuevo `task-stage-config-composition.test.ts` (molde `nocBroadcast.routes.test.ts`) | supertest |

Strict TDD: red → green → refactor, empezar por el test. Cero regresión: suites de segmento/manual/csv verdes
SIN editar aserciones (task APPEND, no reescritura).

## D10 — Coordinación / orden de merge

Este change toca `resolveCombinedRecipients` (nuevo miembro `'task'` en `RecipientSource`, branch APPEND, params
`taskStageIds`/`taskRecipientSource`, `noCustomerCount`) y el `CampaignComposer` FE — MISMOS archivos que
`campaign-chatwoot-label` (en vuelo) y que `bulk-csv-recipients` (base). Todo es ADITIVO (append, no reescritura):
branch nuevo DESPUÉS del CSV, source nuevo, campo nuevo, tab nuevo. **Orden**: si csv/label aterrizan antes,
**rebasar sobre ellos** — los puntos de colisión son (a) el union `RecipientSource` + las uniones `source` de los
DTOs (agregar `'task'` al final), (b) el array de tabs del composer, (c) el bloque de wiring self-contained en
`app.ts` (bloque propio, molde noc-broadcast, no interleava). Las aserciones existentes NO se tocan.

---

## File Changes

| File | Acción | Descripción |
|---|---|---|
| `prisma/schema.prisma` | Modify | + model `WhatsappTaskStageRecipientConfig`; back-relation en `Stage`; `@@index([stageId, generalStatus, customerId])` en `ScheduledTask` (fix wave F1 — `generalStatus`, no `isClosed`) |
| `prisma/migrations/*` | Create | migración aditiva (`prisma:migrate`) |
| `src/domain/ports/TaskStageRecipientConfigRepository.ts` | Create | port config CRUD + `MappedStage` |
| `src/domain/ports/TaskRecipientSource.ts` | Create | port resolución (distinct + count-no-customer) |
| `src/infrastructure/adapters/prisma/PrismaTaskStageRecipientConfigRepository.ts` | Create | adapter config (replace-set transaccional, traduce FK P2003) |
| `src/infrastructure/adapters/prisma/PrismaTaskRecipientSource.ts` | Create | adapter resolución (findMany distinct + count) |
| `src/infrastructure/adapters/in-memory/InMemory{TaskStageRecipientConfigRepository,TaskRecipientSource}.ts` | Create | espejos de tests |
| `src/application/use-cases/{GetTaskStageRecipientConfig,UpdateTaskStageRecipientConfig}.ts` | Create | config CRUD (molde noc-broadcast) |
| `src/application/use-cases/messaging/assertTaskStagesEligible.ts` | Create | guard elegibilidad (molde `assertHasRecipients`) |
| `src/application/use-cases/messaging/resolveCombinedRecipients.ts` | Modify | branch `task`, `MAX_TASK_STATE_RECIPIENTS`, `taskSkipped`, `noCustomerCount`, source `'task'` |
| `src/application/use-cases/messaging/{PreviewCampaignSegment,ListSegmentRecipients,CreateCampaign}.ts` | Modify | inyectan `taskRecipientSource`+`configRepo`, invocan guard, pasan `taskStageIds`, exponen `noCustomerCount` |
| `src/application/use-cases/messaging/assertHasRecipients.ts` | Modify | 4to componente `taskStageIds` |
| `src/application/dto/messaging-bulk.dto.ts` | Modify | `taskStageIds?`, source `'task'`, `noCustomerCount` |
| `src/domain/errors/messaging-bulk.ts` | Modify | 3 errores nuevos |
| `src/infrastructure/http/middleware/errorHandler.ts` | Modify | 2 códigos → 422 |
| `src/infrastructure/http/routes/messagingBulk.routes.ts` | Modify | `toTaskStageIds` + wire en 3 handlers (+GET) |
| `src/infrastructure/http/routes/taskStageConfig.routes.ts` | Create | router config (molde noc-broadcast) |
| `src/infrastructure/http/app.ts` | Modify | wiring: nuevos ports en el bloque bulk + bloque config self-contained |

## Migration / Rollout

Aditivo, SIN feature flag (molde noc-broadcast: la config gobierna la visibilidad). El feature nace oscuro
(tab deshabilitado) hasta que un admin mapee ≥1 stage. Migración aditiva sin backfill.

## Open Questions

- [ ] **Seed RBAC**: ¿algún rol tiene `messaging.bulk` sin `messaging.read`? Si sí → ampliar el gate del GET a
  `messaging.read ∨ messaging.bulk` (D6). Verificar en la fase de spec/tasks.
- [ ] ¿El adapter Prisma de resolución vive como clase propia (`PrismaTaskRecipientSource`) o como método de
  `PrismaSchedulingRepository`? Ambos válidos; decisión de la fase apply (no bloqueante — el port es el contrato).
