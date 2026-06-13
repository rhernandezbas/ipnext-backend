# Design — contract-service-history (#73)

## Decisión 1 — Endpoint
`GET /api/contracts/:contractId/service-history`, montado en `contractServices.routes.ts` (consistente con `/api/contracts/:contractId/services/*`). Guard `auth + requirePerm('clients','read')`. Devuelve `ContractServiceHistoryItemDto[]` ordenado por `createdAt`.

## Decisión 2 — deactivatedAt SÍ (aditivo)
`ContractService` hoy tiene SOLO `createdAt` (no existe `updatedAt`). Por lo tanto la preocupación de "updatedAt pisado por updates posteriores" es inaplicable: no hay updatedAt. Agregar `deactivatedAt DateTime?` es:
- **Trivial:** una columna aditiva nullable, sin backfill obligatorio.
- **Honesto:** representa exactamente la fecha de baja, no un proxy.

Se setea `deactivatedAt = now()` cuando el status pasa `active → inactive`:
- `UpdateContractService` (PATCH manual con `{status:'inactive'}`).
- `reconcileTvContractService` (flujos TV: cancel/remove que inactivan).
Se limpia (`null`) si el servicio se reactiva (`inactive → active`).

La lógica de set/clear vive en el **use case / repo update**, no en la ruta, para que aplique en todos los paths de baja.

## Decisión 3 — Port listByContract
`ContractServiceRepository.listByContract(contractId): Promise<ContractServiceView[]>` — SIN filtro de status (activos + inactivos). Implementado en Prisma (`where: { contractId }, include: { serviceCatalog: true }, orderBy: { createdAt: 'asc' }`) e InMemory (filtra el store por contractId, resuelve catalog vía el seam `catalog`).

`ContractServiceView` gana `deactivatedAt: string | null`.

## Decisión 4 — DTO sin tvPassword
`ContractServiceHistoryItemDto` incluye `tvLogin` (login GIGA{abonado}, no sensible) pero NUNCA `tvPassword`. Mapper `toContractServiceHistoryItemDto(view)` en `contract-services.dto.ts`. Test pinea: `expect(body[0]).not.toHaveProperty('tvPassword')`.

## Decisión 5 — FE modal + DataTable
Botón "Historial" discreto en el `.header` de `ContractCard`, gateado `<Can permission="clients.read">`. Abre `ServiceHistoryModal` (patrón portal de `ConfirmModal`, `max-width ~760px`, Esc + backdrop click + `overflow:hidden`). Dentro, `DataTable<ServiceHistoryEntry>` con columnas Servicio · Estado · Datos · Contratado · Baja y `emptyMessage="Sin historial de servicios para este contrato."`. Datos vía hook `useContractServiceHistory(contractId, enabled)` (TanStack, `enabled` cuando el modal está abierto).

## Limitaciones documentadas
- `deactivatedAt` solo se puebla hacia adelante: filas inactivadas ANTES de esta migración tendrán `deactivatedAt = null` (se mostrará "—" en la columna Baja). No se hace backfill porque no hay un timestamp de baja histórico de dónde derivarlo (no existía `updatedAt`).
- Servicios activos: `deactivatedAt = null`, columna Baja muestra "—" / "Activo".

## Migración
`prisma/migrations/20260711000000_contract_service_deactivated_at/migration.sql`:
```sql
-- Additive only. No BEGIN/COMMIT (Prisma wraps each migration in its own transaction).
ALTER TABLE "ContractService" ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3);
```
Schema: `deactivatedAt DateTime?` en el modelo `ContractService`.
