# contract-service-history (#73)

## Why
La card del contrato (#42) muestra solo los servicios ACTIVOS. Cuando se da de baja un servicio, la fila de `ContractService` se INACTIVA (soft-delete: `status='inactive'`) — el dato sigue en la base, pero no hay forma de verlo desde la UI. Se pide un historial: "si borro cualquier servicio, tenga un historial por lo menos de que estuvo contratado, y los datos asociados".

## What
- **BE (aditivo):** endpoint de solo lectura `GET /api/contracts/:contractId/service-history` que devuelve TODOS los `ContractService` del contrato (activos + inactivos) con: nombre del catálogo, status, notes, tvLogin (NUNCA tvPassword), createdAt (≈ contratado) y deactivatedAt (≈ baja). Gate `clients.read`.
- **Schema (aditivo):** columna `deactivatedAt DateTime?` en `ContractService`, seteada al inactivar (`UpdateContractService` + `reconcileTvContractService`), limpiada al reactivar. Es la fecha de baja honesta — hoy `ContractService` ni siquiera tiene `updatedAt`, solo `createdAt`, así que no hay nada que "pisar".
- **FE:** botón discreto "Historial" en el header de la `ContractCard`, gateado `clients.read`, que abre un modal (lightbox) con una tabla (`DataTable`): Servicio · Estado · Datos (notes/login) · Contratado · Baja. Empty state amable.

## Permisos (dos capas)
- BE: `requirePerm('clients', 'read')` en la ruta nueva (mismo permiso de la vista del cliente).
- FE: `<Can permission="clients.read">` envuelve el botón.

## Seguridad — #65 H3
`tvPassword` JAMÁS viaja en el DTO del historial. Se expone `tvLogin` (login, no credencial sensible) y nada más. Un test pinea la ausencia de `tvPassword`. La password solo sigue disponible por el endpoint gateado existente (`GET /api/gigared/customers/:id/tv-credentials`, `tv.register`) y solo para el activo.

## Wire contract
- `ContractServiceView` (port) gana `deactivatedAt: string | null`.
- `ContractServiceRepository` gana `listByContract(contractId): Promise<ContractServiceView[]>` (sin filtro de status).
- Nuevo DTO `ContractServiceHistoryItemDto` { id, contractId, serviceCatalogId, name, label, status, notes, tvLogin, createdAt, deactivatedAt } — sin tvPassword.
- FE: tipo `ServiceHistoryEntry` en `src/types/customer.ts`.
