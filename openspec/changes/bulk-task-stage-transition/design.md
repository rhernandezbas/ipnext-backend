# Design — bulk-task-stage-transition

Referencia: proposal.md (decisiones 1-7 locked) + specs delta (`messaging-task-stage-config`, `messaging-bulk`,
`messaging-bulk-fe`). Arquitectura hexagonal estricta, TDD (Jest + adapters in-memory), path aliases.

## D1. Config del estado resultante — tabla singleton dedicada

**Decisión:** tabla NUEVA `WhatsappTaskStageTransitionConfig` (singleton, molde `NocBroadcastConfig`), NO extender
`WhatsappTaskStageRecipientConfig`.

**Por qué:** `WhatsappTaskStageRecipientConfig` es un SET (N filas, una por stage elegible); el destino es UN valor global
(1). Meterlo como columna en cada fila del set sería incoherente (¿cuál gana?) y desnormalizado. Un singleton separado
modela exactamente "un solo destino global".

```prisma
model WhatsappTaskStageTransitionConfig {
  id               String   @id @default(uuid())   // singleton — una sola fila (patrón NocBroadcastConfig)
  resultingStageId String?
  resultingStage   Stage?   @relation("TaskTransitionResultingStage", fields: [resultingStageId], references: [id], onDelete: SetNull)
  updatedAt        DateTime @updatedAt
}
```

- `Stage` gana la back-relation `taskTransitionConfigs WhatsappTaskStageTransitionConfig[] @relation("TaskTransitionResultingStage")`.
- Migración **ADITIVA** (nueva tabla + back-relation). Separada de la migración destructiva de D3.
- Singleton: el adapter garantiza 0-o-1 fila (`findFirst` / upsert por una constante). Sin `getResultingStageId` seteado → tabla vacía → `null`.

**Port** (domain/ports/`TaskStageTransitionConfigRepository.ts`, narrow, NUEVO — disciplina D-pattern, no colgarlo del de config existente):
```ts
export interface TaskStageTransitionConfigRepository {
  getResultingStageId(): Promise<string | null>;
  getResultingStage(): Promise<MappedStage | null>;   // hidratado para la card (reusa el shape MappedStage)
  setResultingStageId(stageId: string | null): Promise<void>;  // REPLACE
}
```
Adapters: `PrismaTaskStageTransitionConfigRepository` + `InMemoryTaskStageTransitionConfigRepository`.

**Use cases** (application/use-cases/): `GetTaskStageTransitionConfig` (o extender `GetTaskStageRecipientConfig` para
devolver también `resultingStage`) + `SetTaskStageTransitionConfig` (valida TTC-3: lee el `Stage`, si `code ===
'send_to_iclass'` → `ResultingStageNotAllowedError`; si el id no existe → error tipado). Error nuevo en
`domain/errors/messaging-bulk.ts`: `ResultingStageNotAllowedError` (`RESULTING_STAGE_NOT_ALLOWED` → 422).

**Rutas** (`messagingBulk.routes` / `taskStageConfig.routes`):
- `GET /api/messaging/config/task-stages` → responde `{ stages: MappedStage[], resultingStage: MappedStage | null }` (ADITIVO).
- `PUT /api/messaging/config/task-stages/resulting-stage` (body `{ stageId: string | null }`, Zod) gate `messaging.manage`.

## D2. Resolución per-tarea

**Port `TaskRecipientSource`** (domain/ports) gana:
```ts
listOpenTasksByStages(stageIds: string[]): Promise<{ taskId: string; clientId: string; fromStageId: string }[]>;
```
- Prisma: `scheduledTask.findMany({ where: { stageId: { in }, generalStatus: 'open', customerId: { not: null } },
  select: { id, customerId, stageId } })` → map a `{taskId, clientId, fromStageId}`. **Índice** a agregar:
  `@@index([stageId, generalStatus, customerId])` en `ScheduledTask` (evaluar contra los índices existentes primero).
- Se **conservan** `listClientIdsByOpenTaskStages` (para `noCustomerCount`/compat) y `countOpenTasksWithoutCustomer`.

**Branch task en `resolveCombinedRecipients`** (`:389-456`) — reescrito:
1. Validación de elegibilidad (TASK-2, sin cambios): todos los `taskStageIds` ∈ config mapeada, si no → 422.
2. `tasks = await taskRecipientSource.listOpenTasksByStages(taskStageIds)` (per-tarea).
3. Cap defensivo: `tasks.length > MAX_TASK_STATE_RECIPIENTS` → 422 (ahora cuenta TAREAS).
4. Overlap cross-domain: descartar las tareas cuyo `clientId` ya fue procesado por seg/manual/csv
   (`byClientId`/`segmentCandidateIds`/`manualCandidateIds`/`csvLinkedCandidateIds`) — igual criterio que hoy, pero
   filtrando POR TAREA (una tarea de un cliente ya admitido por otra fuente no genera mensaje task).
5. Hidratar los `clientId` únicos restantes (`findRecipientCandidatesByIds` — batch, reusa el pipeline) → mapa
   `clientId → candidate`. Compliance (opt-out / teléfono inválido) POR CLIENTE (si el cliente está opted-out, TODAS sus
   tareas se excluyen — con su detalle en `taskExcludedDetail`, contadas por tarea).
6. Para cada tarea sobreviviente: `admit` un `CombinedResolvedRecipient` con `source:'task'`, `taskId`, `taskFromStageId =
   fromStageId`, `taskResultingStageId = <resultingStageId global resuelto una vez al inicio de la resolución>`. **Sin
   dedup por teléfono intra-task** (dos tareas del mismo cliente = dos recipients).
7. `resolvedResultingStageId` se lee UNA vez por resolución (`transitionConfigRepo.getResultingStageId()`), se snapshotea
   igual en todos los recipients task de esa campaña.

**`CombinedResolvedRecipient`** gana campos opcionales: `taskId?`, `taskFromStageId?`, `taskResultingStageId?` (solo
poblados para `source:'task'`). El shape de los otros dominios queda idéntico (campos ausentes).

## D3. `CampaignRecipient` — snapshots + migración destructiva del `@@unique`

```prisma
model CampaignRecipient {
  // ... campos existentes ...
  taskId               String?
  task                 ScheduledTask? @relation(fields: [taskId], references: [id], onDelete: SetNull)
  taskFromStageId      String?        // snapshot del origen A (guard still-in-A)
  taskResultingStageId String?        // snapshot del destino B global (o null)
  // @@unique([campaignId, clientId])  → REEMPLAZADO:
  @@unique([campaignId, taskId], name: "campaign_task_unique")   // PARCIAL (ver migración)
}
```

**Migración destructiva — escrita a mano (excepción justificada a "no editar SQL"), transaccional, con backup.** Prisma no
soporta unique parcial (`WHERE`) en el schema declarativo → se declara el `@@unique` para el modelo mental y se ajusta el
SQL a mano a un índice parcial. Plan del `migration.sql` (revisar CON EL USUARIO antes de push):
```sql
-- 1. columnas nuevas (aditivo)
ALTER TABLE "CampaignRecipient" ADD COLUMN "taskId" TEXT,
  ADD COLUMN "taskFromStageId" TEXT, ADD COLUMN "taskResultingStageId" TEXT;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE SET NULL;
-- 2. drop del unique viejo, alta del unique PARCIAL nuevo
DROP INDEX "CampaignRecipient_campaignId_clientId_key";
CREATE UNIQUE INDEX "campaign_task_unique" ON "CampaignRecipient" ("campaignId","taskId")
  WHERE "taskId" IS NOT NULL;
```
- **Guard de seguridad:** las filas viejas tienen `taskId IS NULL` → fuera del índice parcial → nada colisiona. El dedup
  por cliente de los OTROS dominios ya NO lo garantiza la constraint (queda a cargo de `resolveCombinedRecipients`, que ya
  dedupea por `byClientId`); documentar este cambio de invariante.
- **NO** `BEGIN/COMMIT` dentro del `migration.sql` (`migrate deploy` envuelve). Dry-run rolled-back vs. prod ANTES del deploy.
- Backup: `CREATE TABLE _bak_campaign_recipient_unique AS SELECT ...` opcional (aditivo puro salvo el swap de índice — bajo riesgo, pero se confirma con el usuario).

## D4. Transición en el envío — port + use case dedicado, `SendCampaign` lo invoca aislado

**Hexagonal:** `SendCampaign` NO debe conocer `SchedulingRepository`/`StageRepository`. Se define un port narrow y un
use case que compone la lógica de guard + reuso de `MoveTaskToStage`.

**Port** (domain/ports/`CampaignTaskTransitionPort.ts`):
```ts
export type TaskTransitionOutcome = 'moved' | 'skipped_not_in_origin' | 'skipped_iclass' | 'skipped_no_target';
export interface CampaignTaskTransitionPort {
  transition(input: { taskId: string; fromStageId: string; toStageId: string }): Promise<TaskTransitionOutcome>;
}
```

**Adapter/use case** (application/use-cases/messaging/`TransitionTaskAfterSend.ts`) — implementa el port componiendo:
```ts
async transition({ taskId, fromStageId, toStageId }): Promise<TaskTransitionOutcome> {
  const task = await this.tasks.getTask(taskId);
  if (!task) return 'skipped_not_in_origin';                       // ya no existe
  if (task.stageId !== fromStageId) return 'skipped_not_in_origin'; // TRANS-2: humano la movió
  const target = await this.stages.getById(toStageId);
  if (target?.code === 'send_to_iclass') return 'skipped_iclass';   // TRANS-3: red de seguridad
  await this.moveTaskToStage.execute(taskId, toStageId, SYSTEM_ACTOR); // reusa el use case (stage_changed + feed)
  return 'moved';
}
```

**`SendCampaign`** gana un 6º dep OPCIONAL `taskTransition?: CampaignTaskTransitionPort` (molde `inboxProjector`: ausente →
no-op, backcompat exacto). Nuevo método privado `transitionTaskIfNeeded(recipient)` invocado en `processRecipient` DESPUÉS
de `persistRecipientSent`/`projectToInbox`/`applyChatwootLabel`:
```ts
private async transitionTaskIfNeeded(recipient: CampaignRecipient): Promise<void> {
  if (!this.taskTransition || !recipient.taskId || !recipient.taskResultingStageId) return;
  try {
    await this.taskTransition.transition({
      taskId: recipient.taskId,
      fromStageId: recipient.taskFromStageId!,
      toStageId: recipient.taskResultingStageId,
    });
  } catch (err) {
    console.error(`[SendCampaign] transición de tarea falló para recipient ${recipient.id} (best-effort/aislada, el envío ya está 'sent'):`, err);
  }
}
```
Aislado/best-effort: NUNCA re-marca `failed` (TRANS-1). Idempotente: mover a B una tarea ya en B es guardado por
`MoveTaskToStage` (`fromStageId === toStageId` → sin `stage_changed`); el guard still-in-A cubre el resto.

`CampaignRepository`/`CampaignRecipient` (entity) deben exponer `taskId`/`taskFromStageId`/`taskResultingStageId` en el
recipient que `listRecipientsKeyset` devuelve (para que el envío los lea del snapshot, no re-resuelva).

## D5. Wiring (`app.ts`) — verificado a mano + composition-root test

- Instanciar `PrismaTaskStageTransitionConfigRepository` + sus use cases + rutas (GET extendido, PUT nuevo).
- Instanciar `TransitionTaskAfterSend` (compone `SchedulingRepository` + `StageRepository` + `MoveTaskToStage` ya
  existentes en el wiring de scheduling) e **inyectarlo como 6º arg de `SendCampaign`** (y del `CampaignRunner` que lo
  crea). **Lección W6 (EPIC #38):** el wiring de `app.ts` se verifica a mano contra este design + se pinea con un
  composition-root test (assert estático de que `SendCampaign` recibe el `taskTransition`), o la feature queda MUERTA en
  prod con CI verde (params opcionales + tests que inyectan su propio wiring).

## D6. Orden de implementación (TDD, red→green→refactor)

1. Config singleton (schema aditivo + port + adapters + use cases + validación send_to_iclass + rutas) — **aislado, sin riesgo.**
2. `listOpenTasksByStages` en el port + adapters (per-tarea) + índice.
3. Branch task per-tarea en `resolveCombinedRecipients` (sin dedup teléfono intra-task, snapshots) + cap por-tarea.
4. Schema `CampaignRecipient` (columnas + FK) — **migración aditiva primero**; la reforma del `@@unique` en una migración
   destructiva SEPARADA (D3), revisada con el usuario.
5. `CampaignTaskTransitionPort` + `TransitionTaskAfterSend` + tests.
6. Efecto post-`sent` en `SendCampaign` + guards (TRANS-1..4).
7. Wiring `app.ts` + composition-root test.
8. FE: card de Config (selector único, excluye send_to_iclass, confirm) + preview por-tarea.

Cada paso: test que falla primero. Gate del orquestador (suite + tsc) tras cada batch. Review adversarial (foco: migración
destructiva, snapshot/idempotencia, guard still-in-A, aislamiento best-effort, wiring) → fix wave → re-review CLEAN.
