# Tasks — task-completeness-tracking (#14)

Strict TDD (red→green). BE grueso, FE chico. Verify completo antes de cada deploy.

## Backend (ipnext-backend)

- [ ] **1. Modelo + entidad + DTO** (sin lógica todavía)
  - `prisma/schema.prisma`: `ScheduledTask` += `closureCommentDone`, `closureAuditDone`, `closureHasDeviceInventory` (`Boolean @default(false)`).
  - `domain/entities` ScheduledTask + `PrismaSchedulingRepository.toEntity` + omits de `CreateTaskInput`/`UpdateTaskInput` (recorrido de `reviewedByInventory`).
  - El DTO/respuesta de la tarea expone los 3 flags. `tsc` verde.

- [ ] **2. Helper `hasDeviceForTask`** (`InventorySuggestionRepository`)
  - RED+GREEN: in-memory + Prisma → `true` si hay sugerencia DEVICE con status ≠ `discarded` (o ítem instalado con `sourceTaskId`); `false` con solo materiales o DEVICE descartado.

- [ ] **3. `markClosureCompleteness`** (`SchedulingRepository`)
  - Método dedicado (NO `updateTask`): `markClosureCompleteness(taskId, partial)`. In-memory + Prisma. Test in-memory: setea solo los flags pasados, no toca otros campos ni emite actividad.

- [ ] **4. RED+GREEN — el closure marca los flags** (`IngestClosedServiceOrders.test.ts`)
  - RED: tras `runClosureSideEffects` → `closureCommentDone`/`closureAuditDone` true; `closureHasDeviceInventory` true si hubo DEVICE, false si solo materiales.
  - GREEN: en `runClosureSideEffects`, tras `markSideEffect('commentPosted')` → `markClosureCompleteness({closureCommentDone:true})`; tras audit no-null → `{closureAuditDone:true}`; tras `buildSuggestions` → `hasDeviceForTask` → `{closureHasDeviceInventory: …}`.

- [ ] **5. Migración: columnas + seed flag + backfill**
  - `<ts>_task_completeness_fields/migration.sql`: `ADD COLUMN` ×3 + seed `INSERT FeatureFlag('task-autocomplete', false) ON CONFLICT DO NOTHING` + backfill (UPDATE desde `TaskInstallationAudit` / `TaskInventorySuggestion` DEVICE no-descartado / `IClassServiceOrder.commentPosted`).
  - **Mostrar el SQL al usuario antes de pushear.**

- [ ] **6. Cron de auto-completado**
  - `TaskAutocompleteScheduler` (espeja `IClassClosureScheduler`: inFlight + DistributedLock distinto + intervalo + re-lee flag por tick, dormido OFF). Corre `ReprocessClosureSideEffects` instanciado con `flagKey: 'task-autocomplete'`. Bootstrap + wiring en `app.ts`/composition.
  - Test: flag OFF → no corre; ON → corre el reprocess.

- [ ] **7. Verify BE** — `tsc` (0) + `npx jest --runInBand` (verde). Commit + deploy (OK del usuario) + confirmar run en `gh` (incluido el step de migraciones).

## Frontend (ipnext-frontend)

- [ ] **8. RED+GREEN — toggle `task-autocomplete`** (en la sub-page "Cierre de OS", `IClassClosureFlagBody`)
  - Card/toggle cableado al flag `task-autocomplete` (patrón del toggle del auditor #7), gate `iclass.manage`. Test: refleja/flip el flag.

- [ ] **9. Verify FE** — `tsc` (0) + `npx vitest run` (verde). Commit + deploy (OK) + `gh`.

## Cierre

- [ ] **10. Archive + docs** — `sdd-archive` (mover change a `archive/`). Commit `BACKLOG.md`: #14 → hecho.
