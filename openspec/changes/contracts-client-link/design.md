# Design — contracts-client-link (#56)

## BE (hexagonal, aditivo)
Dirección de dependencias intacta: el use case sigue dependiendo solo del port.

- `domain/ports/ContractRepository.ts` — `ContractListItem` += `clientId: string`.
- `application/dto/contract.dto.ts` — `ContractSummaryDto` += `clientId: string`.
- `application/use-cases/ListContracts.ts` — mapea `s.clientId` al DTO de salida.
- `infrastructure/adapters/in-memory/InMemoryContractRepository.ts` — `seed` default `clientId = randomUUID()` para no romper fixtures existentes.
- `infrastructure/adapters/prisma/PrismaContractRepository.ts` — `toContractListItem` += `clientId: row.clientId`. La columna escalar `clientId` ya viene en `findMany`; el `include: { client: { select: { name: true } } }` solo trae el name, no hace falta tocarlo.

## FE
- `types/contract.ts` — `ContractSummary` += `clientId: string`.
- `pages/contracts/ContractsListPage.tsx` — `import { Link }`; columna "Cliente" con `render: (row) => <Link to={\`/admin/customers/view/${row.clientId}\`} className={styles.clientLink}>{row.clientName}</Link>`.
- `pages/contracts/ContractsListPage.module.css` — `.clientLink` copiando el patrón `.customerLink` de #47j (`color: var(--color-accent)`, sin subrayado, `font-weight: 500`, hover subrayado).

## Patrón de referencia (#47j)
`CustomersListPage.tsx` columna "Nombre completo" usa `<Link to={\`/admin/customers/view/${row.id}\`} className={styles.customerLink}>`. No existe componente reusable `CustomerLink`; se hace inline. Ruta confirmada en `App.tsx`: `path="view/:id"` bajo `/admin/customers`, gateada con `clients.read`.

## Riesgo aceptado — mismatch de permisos (fix wave #56, LOW)
La lista de contratos se gatea con `contracts.read`, pero el destino del hiperlink
(`/admin/customers/view/:id`) se gatea con `clients.read`. Un rol que tenga
`contracts.read` SIN `clients.read` puede ver la lista, clickear el nombre y caer
en la pantalla de acceso denegado del destino.

**Decisión del arquitecto: aceptado como riesgo.** Es consistente con #47j, donde el
deep-link de cuentas Gigared al cliente Prominense tiene el mismo mismatch. No se
agrega gating cruzado ni se oculta el link condicionalmente por permiso: el costo
(consultar permisos del destino en la lista) no justifica el beneficio para un
combo de roles atípico. Si en el futuro aparece un rol real con esa combinación,
se reevalúa.

## Tests (Strict TDD)
- BE: `__tests__/application/ListServices.test.ts` (test del use case `ListContracts`) verifica `clientId` en el item.
- FE: `__tests__/contracts/ContractsListPage.test.tsx` CP-1b verifica `href === /admin/customers/view/:clientId` usando `clientId` (no el contract id).
