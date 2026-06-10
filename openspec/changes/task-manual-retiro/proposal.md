# Proposal: Retiro Manual de Equipos desde la Tarea (Backlog #39)

## Intent

Hoy el "retiro" manual en la UI (`DELETE /contracts/:id/inventory/:itemId` → `RemoveInstalledItem`) solo marca el CII como `removed`: NO mueve el asset ni el ledger. El equipo "retirado" queda colgado en su ubicación instalada. Falta el flujo operativo que un técnico/operador usa para retirar equipos de un contrato y devolverlos al depósito, gateado por proyectos habilitados, con asset + movimiento atómicos.

## Scope

### In Scope
- Flag `Project.allowsEquipmentRetirement boolean @default(false)` (migración aditiva) + config tab "Proyectos de retiro" (`inventory.manage`).
- Use case `RetireContractEquipment`: CII → `removed` + RETURN del asset a `available@DEPOSITO` (+1), atómico para N ítems (`source='MANUAL'`, `taskId`).
- Endpoint `POST /scheduling/:taskId/inventory/retire` body `{ itemIds: string[] }` (`inventory.write`).
- Flag `projectAllowsRetirement` en el task DTO (gate sin RTT extra; validación real es server-side).
- Picker por ítem (retiros parciales) en `InventoryPanel` de la tab Inventory de la tarea, aplicación directa con confirm-dialog.

### Out of Scope
- Flujo W4 automático (retiros IClass → depósito) — intacto.
- Materiales (consumibles) y `MaterialConsumption`.
- Staging en Devoluciones / `ReturnSuggestion` — aplicación directa, sin cola.

## Capabilities

### New Capabilities
- `inventory-manual-retirement`: retiro manual por ítem desde la tarea — gating por proyecto, use case atómico CII+asset+movimiento, endpoint task-scoped, picker FE.

### Modified Capabilities
- `projects`: `Project` gana `allowsEquipmentRetirement` (config + exposición en PATCH).
- `scheduling-task-detail`: task DTO gana `projectAllowsRetirement` (flag computado del JOIN).

## Approach

Espejo de `ConfirmAssetReturn` (W4) generalizado a N ítems en un único `UnitOfWork.runInTransaction` (todo-or-nothing — D6/R2). Guards server-side en orden: task existe → tiene `contractId` (else 422 `TASK_HAS_NO_CONTRACT`) → proyecto con `allowsEquipmentRetirement===true` (else 422 `PROJECT_NOT_RETIREMENT`, D4) → por ítem: CII activo del contrato. CIIs legacy sin `assetId` → CII a `removed` sin movimiento (D8/R4); asset ya en depot → skip idempotente, CII igual `removed` (R5). Idempotencia: `sourceRef='manual:retire:{taskId}:{ciiId}'`. El gating por proyecto-mapeado ES el interruptor natural (default ninguno mapeado ⇒ feature inerte) — por eso NO se agrega feature flag dedicado.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` + migration | Modified/New | `allowsEquipmentRetirement` en `Project` |
| `domain/entities/project.ts`, `ports/ProjectRepository.ts` | Modified | Campo + `UpdateProjectInput` |
| `application/use-cases/RetireContractEquipment.ts` | New | Use case atómico N-ítems |
| `domain/errors/inventory.ts` | Modified | `TaskHasNoContractError`, `ProjectNotRetirementError`, `EquipmentNotOnContractError` |
| `adapters/prisma/PrismaSchedulingRepository.ts` | Modified | JOIN + mapper `projectAllowsRetirement` |
| `http/routes/scheduling.routes.ts`, `app.ts` | Modified | Endpoint + wiring |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Migración en `Project` (tabla viva, FKs) | Low | `ADD COLUMN DEFAULT false` = metadata-only en PG, instantáneo (R1) |
| Atomicidad N ítems | Med | Un solo `runInTransaction` con N writes, rollback total (R2) |
| CIIs legacy sin `assetId` | Med | CII siempre `removed`; movimiento solo si `assetId` (R4) |
| `projectAllowsRetirement` no propagado en tests in-memory | Med | Mapper + InMemory repos default `false` (R6) |

## Rollback Plan

Revertir el merge. El flag arranca `false` en todos los proyectos (feature inerte). Migración inversa: `DROP COLUMN allowsEquipmentRetirement` (aditivo, sin data crítica). Sin proyectos mapeados el endpoint siempre rechaza con `PROJECT_NOT_RETIREMENT`.

## Dependencies

- `ConfirmAssetReturn` (patrón), `ResolveDepotLocation`, `UnitOfWork` (slots `inventory`/`assets`/`movements` ya en el bag).

## Success Criteria

- [ ] Solo tareas de proyectos mapeados muestran y permiten "Retirar" (FE + BE).
- [ ] Retiro parcial por picker: CII `removed` + asset `available@DEPOSITO` (+1) atómico.
- [ ] CII legacy sin asset → `removed` sin movimiento; asset ya en depot → idempotente.
- [ ] `source='MANUAL'` y `taskId` en el movimiento; sin `ReturnSuggestion`.
