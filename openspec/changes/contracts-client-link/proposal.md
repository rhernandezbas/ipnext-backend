# contracts-client-link (#56)

## Why
En `/admin/contracts/` el nombre del cliente era texto plano. Se pide que sea un hiperlink al detalle del cliente (`/admin/customers/view/:clientId`), igual que el patrón de `/admin/customers` (#47j / FE PR #95). Desde la lista de contratos hay que poder saltar directo a la ficha del cliente.

## What
- **BE (aditivo):** exponer `clientId` en el DTO del listado de contratos. Antes solo traía `clientName`, sin el id necesario para construir el link.
- **FE:** convertir la celda "Cliente" de la tabla en un `<Link>` de react-router-dom hacia `/admin/customers/view/:clientId`.

## Permisos
No agrega superficie nueva: la ruta de detalle de cliente (`view/:id`) ya está gateada con `clients.read` en `App.tsx`. Un `<Link>` no requiere permiso adicional.

## Wire contract
`ContractSummaryDto` / `ContractSummary` ganan el campo `clientId: string` (cambio aditivo, no rompe consumidores existentes).
