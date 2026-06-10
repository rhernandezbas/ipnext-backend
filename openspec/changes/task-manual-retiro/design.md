# Design: Retiro Manual de Equipos desde la Tarea (#39)

## Technical Approach

Generalizar `ConfirmAssetReturn.handleReturn` (W4) a N ítems en UN `uow.runInTransaction`. Nuevo use case `RetireContractEquipment(taskId, itemIds, actorId)`: guards en cascada server-side → loop atómico que, por CII, marca `removed` y (si tiene `assetId`) emite un `RETURN` a DEPOSITO con `source='MANUAL'`. Gating natural por `Project.allowsEquipmentRetirement` (sin feature flag dedicado). `RemoveInstalledItem` (#8) sobrevive intacto como el "quitar administrativo" sin depósito — el retire NO lo reemplaza (conviven; ver Decisión 4).

## Architecture Decisions

| Tema | Opción elegida | Alternativa rechazada | Razón |
|------|----------------|------------------------|-------|
| Atomicidad N (R2) | UN `runInTransaction` con loop de N writes dentro | N transacciones (una por ítem) | Todo-or-nothing: falla el ítem 3/5 → rollback total. `ConfirmAssetReturn.runUnit` ya prueba el patrón. |
| Migración (R1) | `ADD COLUMN allowsEquipmentRetirement BOOLEAN NOT NULL DEFAULT false` | Tabla N:M aparte | 1:1 binario = clon de `visible`. ADD COLUMN DEFAULT = metadata-only en PG, instantáneo en tabla viva. |
| Idempotencia doble-click (R7) | `sourceRef='manual:retire:{taskId}:{ciiId}'` + pre-write `findBySourceRef`→409 | Confiar solo en partial-unique | L2 keyed al **CII** (no al asset): retiro parcial del MISMO contrato no colisiona. Clave por par task+cii. |
| Asset no-`installed` (R5) | `installed`→RETURN; cualquier otro estado→skip idempotente, CII igual `removed` | 409 duro | Coherente con W4 Fix#1 pero graceful: retiro doble no debe fallar. |
| CII legacy sin `assetId` (R4) | CII siempre `removed`; movimiento solo si `assetId != null` | Saltar el CII | El soft-delete es historial semántico; sin asset no hay stock que mover. |
| Coexistencia #8 | `RemoveInstalledItem` queda como quitar admin sin depósito | Reemplazar en UI | El retire es la acción "con depósito" gateada por proyecto; el quitar sigue para correcciones fuera de proyecto de retiro. |

## Data Flow

```
POST /scheduling/:taskId/inventory/retire {itemIds[]}  (auth + inventory.write)
   └─ RetireContractEquipment.execute
        guards: getTask→404 │ contractId? else 422 TASK_HAS_NO_CONTRACT
                projectId+project.allowsEquipmentRetirement? else 422 PROJECT_NOT_RETIREMENT
        uow.runInTransaction(b):
          for ciiId in itemIds:
            cii=b.inventory.getById → del contrato? else 403 EQUIPMENT_NOT_ON_CONTRACT
            if cii.status!=='active': skip (idempotente)
            b.inventory.remove(ciiId)                          # → removed
            if cii.assetId:
              if b.movements.findBySourceRef(ref): continue    # ya retirado
              asset=b.assets.findById; if status==='installed':
                b.movements.record(RETURN, asset, →DEPOSITO, taskId, source:'MANUAL', sourceRef)
        → RetireContractEquipmentResult{retired[], skipped[]}
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modify | `allowsEquipmentRetirement Boolean @default(false)` en `Project` |
| `prisma/migrations/2026XXXX_project_retirement_flag/` | Create | ADD COLUMN aditivo (vía `prisma migrate dev`) |
| `domain/entities/project.ts` | Modify | Campo `allowsEquipmentRetirement: boolean` |
| `domain/ports/ProjectRepository.ts` + `dto/projects.dto.ts` | Modify | `allowsEquipmentRetirement?: boolean` en Update input + Zod |
| `application/use-cases/UpdateProject.ts` | Modify | Passthrough (sin FK lookup) |
| `domain/errors/inventory.ts` | Modify | `ProjectNotRetirementError`(422), `EquipmentNotOnContractError`(403). `TaskHasNoContractError` ya existe |
| `domain/entities/scheduling.ts` | Modify | `projectAllowsRetirement?: boolean` |
| `application/use-cases/RetireContractEquipment.ts` | Create | Use case atómico N-ítems |
| `adapters/prisma/PrismaSchedulingRepository.ts` | Modify | `toTask`: `projectAllowsRetirement: row.project?.allowsEquipmentRetirement ?? false` (R6 — INCLUDE.project ya trae la fila) |
| `adapters/prisma/PrismaProjectRepository.ts` | Modify | Select/mapeo del campo |
| `adapters/in-memory/InMemoryProjectRepository.ts` + scheduling/contract in-memory | Modify | Default `false` (R6) |
| `http/routes/scheduling.routes.ts` | Modify | `POST /:taskId/inventory/retire` (auth+invWrite), errores→404/422/403 |
| `http/app.ts` | Modify | `new RetireContractEquipment(...)` + inyección en createSchedulingRouter |

## Interfaces / Contracts

```ts
interface RetireContractEquipmentInput { taskId: string; itemIds: string[]; actorId: string | null; }
interface RetiredItemDTO { itemId: string; status: 'removed'; assetId: string | null; movementId: string | null; }
interface RetireContractEquipmentResult { retired: RetiredItemDTO[]; skipped: { itemId: string; reason: 'already-removed' }[]; }
// UoW: reusar slots inventory+assets+movements (ya en TransactionalRepos). DI: ContractInventoryRepository, InventoryAssetRepository, InventoryMovementRepository, ResolveDepotLocation, SchedulingRepository(getTask), ProjectRepository(get), UnitOfWork.
```

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | SCEN-1 retiro N atómico (CII removed + RETURN +1 @depot) · SCEN-2 proyecto no-retiro→422 · SCEN-3 sin contrato→422 · SCEN-4 CII de otro contrato→422 · SCEN-5 legacy sin assetId→removed sin mov · SCEN-6 asset ya en depot→skip · SCEN-7 doble-click mismo itemId→1 sólo RETURN (sourceRef) · SCEN-8 falla ítem k → rollback total (R2) | `InMemory*Repository` + UoW in-memory (rollback real). NO mockear Prisma. |
| Integration | route 200/404/422/403; projectAllowsRetirement en getTask DTO (R6); PATCH project flag | supertest, repos in-memory |
| E2E (FE) | botón visible solo si `projectAllowsRetirement && contractId`; modal multi-select; disabled-while-pending | manual/component |

## Migration / Rollout

Aditiva, sin backfill (`DEFAULT false`). Sin proyectos mapeados ⇒ feature inerte (endpoint siempre 422 `PROJECT_NOT_RETIREMENT`). Rollback = revertir merge; inversa `DROP COLUMN`.

## FE

- **`TaskTabs.tsx`→`InventoryPanel`**: botón "Retirar equipos" bajo `Can permission="inventory.write"`, visible solo si `projectAllowsRetirement && contractId`. Abre modal multi-select que reusa `useServiceInstalledItems(contractId)` (mismo fetch que `ContractInventoryReadonly`) filtrando `status==='active'`; cada fila muestra foto/serial/tipo. Confirm con resumen → mutation `retireEquipment(taskId, itemIds)`; botón `disabled` while pending; invalida la query del inventario.
- **Threading**: `SchedulingTaskDetailPage` pasa `projectAllowsRetirement` del task DTO → `TaskTabs` → `InventoryPanel` (junto a `contractId`).
- **Config**: tab "Proyectos de retiro" en `InventorySettingsPage` (no Scheduling), gateada `inventory.manage`; `RetirementProjectsBody.tsx` clona `IClassProjectMappingBody` (tabla con toggle por fila, auto-save inline vía PATCH `/projects/:id {allowsEquipmentRetirement}`).
- **Types**: `Project.allowsEquipmentRetirement: boolean`, `ScheduledTask.projectAllowsRetirement?: boolean`.

## Risks

R2 atomicidad N → un solo runInTransaction (test SCEN-8). R4 legacy → CII removed sin mov (SCEN-5). R6 JOIN → mapper + in-memory default false. R7 doble-click → sourceRef por task+cii + pre-write findBySourceRef (SCEN-7).

## Open Questions

- [ ] Confirmar path final `POST /scheduling/:taskId/inventory/retire` (proposal) — alineado con sub-rutas task-scoped existentes.
