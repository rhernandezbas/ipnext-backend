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

## Tests (Strict TDD)
- BE: `__tests__/application/ListServices.test.ts` (test del use case `ListContracts`) verifica `clientId` en el item.
- FE: `__tests__/contracts/ContractsListPage.test.tsx` CP-1b verifica `href === /admin/customers/view/:clientId` usando `clientId` (no el contract id).
