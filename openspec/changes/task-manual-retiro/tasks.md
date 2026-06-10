# Tasks: Retiro Manual de Equipos desde la Tarea (#39)

## Phase 1: Migración + Prisma

- [x] 1.1 [RED] `src/__tests__/infrastructure/migration.project_retirement_flag.test.ts` — snapshot test: columna `allowsEquipmentRetirement BOOLEAN NOT NULL DEFAULT false` existe en `Project`; migration idempotente.
- [x] 1.2 [GREEN] `prisma/schema.prisma` — agregar `allowsEquipmentRetirement Boolean @default(false)` al modelo `Project`.
- [x] 1.3 `prisma/migrations/202606XXXXXXXX_project_retirement_flag/migration.sql` — `ALTER TABLE "Project" ADD COLUMN "allowsEquipmentRetirement" BOOLEAN NOT NULL DEFAULT false;` (sin `updatedAt` DEFAULT, paridad exacta).
- [x] 1.4 `npx prisma generate` — regenerar cliente Prisma; quitar `as any` casts en `PrismaProjectRepository` si el tipo ya fue generado.

## Phase 2: Domain

- [x] 2.1 `src/domain/entities/project.ts` — agregar `allowsEquipmentRetirement: boolean` a la interfaz `Project`.
- [x] 2.2 `src/domain/entities/scheduling.ts` — agregar `projectAllowsRetirement?: boolean` al DTO de tarea.
- [x] 2.3 `src/domain/errors/inventory.ts` — agregar `ProjectNotRetirementError` (422, `PROJECT_NOT_RETIREMENT`) y `EquipmentNotOnContractError` (422, `EQUIPMENT_NOT_ON_CONTRACT`). `RetireAlreadyDoneError` (409, `RETIRE_ALREADY_DONE`). (`TaskHasNoContractError` ya existe.)
- [x] 2.4 `src/domain/ports/ProjectRepository.ts` — agregar `allowsEquipmentRetirement?: boolean` a `UpdateProjectInput`.

## Phase 3: UpdateProject + Task mapper

- [x] 3.1 [RED] `src/__tests__/application/use-cases/UpdateProject.test.ts` — SCEN-MAP-1: flag persiste; SCEN-MAP-4: nuevo proyecto defaultea `false`.
- [x] 3.2 [GREEN] `src/application/use-cases/UpdateProject.ts` — pasar `allowsEquipmentRetirement` del input al repositorio (passthrough sin lógica adicional).
- [x] 3.3 `src/application/dto/projects.dto.ts` — agregar `allowsEquipmentRetirement: z.boolean().optional()` al schema Zod de update; incluir el campo en el DTO de salida.
- [x] 3.4 [RED] `src/__tests__/infrastructure/PrismaSchedulingRepository.toTask.test.ts` — SCEN-MAP-5/6/7: `projectAllowsRetirement` derivado del JOIN `project.allowsEquipmentRetirement ?? false`.
- [x] 3.5 [GREEN] `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` — `toTask`: añadir `projectAllowsRetirement: row.project?.allowsEquipmentRetirement ?? false`; incluir campo en `INCLUDE.project`.
- [x] 3.6 `src/infrastructure/adapters/prisma/PrismaProjectRepository.ts` — agregar `allowsEquipmentRetirement` en `EnrichedProjectRow`, `mapProject`, y en `create`/`update`.
- [x] 3.7 `src/infrastructure/adapters/in-memory/InMemoryProjectRepository.ts` — default `allowsEquipmentRetirement: false` en create y update stubs.
- [x] 3.8 `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` — default `projectAllowsRetirement: false` en tareas sin proyecto mapeado.
- [x] 3.9 [RED] `src/__tests__/infrastructure/projects.routes.test.ts` — SCEN-MAP-2: PATCH sin `inventory.manage` → 403 al enviar `allowsEquipmentRetirement`.
- [x] 3.10 [GREEN] `src/infrastructure/http/routes/projects.routes.ts` — guard `inventory.manage` para la mutación del campo `allowsEquipmentRetirement` (per-field o condicional en el PATCH handler).

## Phase 4: RetireContractEquipment (TDD estricto)

- [x] 4.1 [RED] `src/__tests__/application/RetireContractEquipment.test.ts` — SCEN-RET-7: sin contractId → 422 `TASK_HAS_NO_CONTRACT`.
- [x] 4.2 [RED] añadir SCEN-RET-6: project `allowsEquipmentRetirement: false` → 422 `PROJECT_NOT_RETIREMENT`.
- [x] 4.3 [RED] añadir SCEN-RET-4: CII de otro contrato → 422 `EQUIPMENT_NOT_ON_CONTRACT`.
- [x] 4.4 [RED] añadir SCEN-RET-1: happy path CII+assetId → `removed` + RETURN movement `source='MANUAL'` + `sourceRef='manual:retire:T1:CII1'`.
- [x] 4.5 [RED] añadir SCEN-RET-3: legacy sin assetId → CII `removed`, sin InventoryMovement.
- [x] 4.6 [RED] añadir SCEN-RET-5: re-retire mismo CII → 409 `RETIRE_ALREADY_DONE` (pre-write `findBySourceRef`).
- [x] 4.7 [RED] añadir SCEN-RET-2: N ítems, uno falla → rollback total (CII1+CII2 NO removidos).
- [x] 4.8 [RED] añadir SCEN-RET-8: `itemIds: []` → 400 `VALIDATION_ERROR`.
- [x] 4.9 [RED] añadir SCEN-DEP-1/DEP-2: asset aparece `available` en depot; ledger con `source: 'MANUAL'`, `taskId`, `from: CLIENTE`, `to: DEPOSITO`.
- [x] 4.10 [GREEN] `src/application/use-cases/RetireContractEquipment.ts` — use case con guards en cascada + `uow.runInTransaction` con loop N ítems; `findBySourceRef` pre-write para idempotencia; legacy path sin asset; skip graceful para asset ya en depot.

## Phase 5: Ruta + Wiring

- [x] 5.1 [RED] `src/__tests__/infrastructure/inventory-retire.routes.test.ts` — SCEN-RET-9: sin `inventory.write` → 403; SCEN-RET-8: `itemIds: []` → 400; SCEN-RET-7: sin contrato → 422; SCEN-RET-1: happy path → 200.
- [x] 5.2 [GREEN] `src/infrastructure/http/routes/scheduling.routes.ts` — agregar `POST /:taskId/inventory/retire` con guard `invWrite`; inyectar `retireContractEquipment` en `createSchedulingRouter`; mapear errores `ProjectNotRetirementError` / `EquipmentNotOnContractError` / `RetireAlreadyDoneError` a 422/409.
- [x] 5.3 [RED] `src/__tests__/infrastructure/inventory-composition-root.test.ts` — assertion que `RetireContractEquipment` está wired en la composition root.
- [x] 5.4 [GREEN] `src/infrastructure/http/app.ts` — instanciar `RetireContractEquipment` e inyectar en `createSchedulingRouter`.

## Phase 6: Frontend

- [x] 6.1 `src/types/scheduling.ts` (o equivalente FE) — agregar `projectAllowsRetirement?: boolean` a `ScheduledTask`; `allowsEquipmentRetirement: boolean` a `Project`.
- [x] 6.2 [RED] test SCEN-FE-1/2/3: `InventoryPanel` muestra botón solo si `projectAllowsRetirement && contractId && can('inventory.write')`.
- [x] 6.3 [GREEN] `InventoryPanel.tsx` — botón "Retirar equipos" bajo `<Can permission="inventory.write">`; visible solo si `task.projectAllowsRetirement && task.contractId`.
- [x] 6.4 [RED] test SCEN-FE-4: picker muestra solo CIIs `status === 'active'`.
- [x] 6.5 [GREEN] `RetireEquipmentModal.tsx` — multi-select de CIIs activas (reutiliza `useServiceInstalledItems(contractId)` filtrando `active`); confirm con resumen; botón disabled mientras pending.
- [x] 6.6 [RED] test SCEN-FE-5: POST exitoso invalida query inventario + sidebar; CII retirada desaparece.
- [x] 6.7 [GREEN] mutation `retireEquipment(taskId, itemIds)` en hook/service; on success: `invalidateQueries` inventory + sidebar.
- [x] 6.8 [RED] test SCEN-FE-6: POST 422 muestra toast con mensaje español mapeado.
- [x] 6.9 [GREEN] manejo de errores en modal: mapear `PROJECT_NOT_RETIREMENT` / `EQUIPMENT_NOT_ON_CONTRACT` / `RETIRE_ALREADY_DONE` a mensajes en español; toast de error.
- [x] 6.10 Threading: `SchedulingTaskDetailPage` pasa `projectAllowsRetirement` del task DTO → `TaskTabs` → `InventoryPanel`.
- [x] 6.11 [RED] test SCEN-FE-7/8/9: tab "Proyectos de retiro" en `InventorySettingsPage`; toggle visible con `inventory.manage`; PATCH auto-save; read-only sin toggles.
- [x] 6.12 [GREEN] `RetirementProjectsBody.tsx` — clona `IClassProjectMappingBody`; lista de proyectos con toggle `allowsEquipmentRetirement` por fila; auto-save inline via `PATCH /api/projects/:id`.

## Phase 7: Verify

- [x] 7.1 `npm test` — todos los tests en verde (BE: Jest + ts-jest). 386 suites / 3114 pass / 86 skip / 0 fail.
- [x] 7.2 `tsc --noEmit` — sin errores de tipo en BE.
- [ ] 7.3 FE: `vitest run` + `tsc --noEmit` — sin errores.
- [ ] 7.4 [ORCHESTRATOR] dry-run migración contra DB de dev: `npx prisma migrate deploy --preview-feature` o equivalente.
