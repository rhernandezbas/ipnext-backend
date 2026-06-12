# Tasks — contracts-client-link (#56)

## BE (aditivo, TDD)
- [x] RED: `ListServices.test.ts` espera `clientId` en el item + test dedicado #56
- [x] `ContractRepository` port: `ContractListItem` += `clientId`
- [x] `contract.dto.ts`: `ContractSummaryDto` += `clientId`
- [x] `ListContracts.ts`: mapear `clientId`
- [x] `InMemoryContractRepository` seed: `clientId` default `randomUUID()`
- [x] `PrismaContractRepository.toContractListItem`: `clientId: row.clientId`
- [x] GREEN: `jest ListServices + GetServiceStats` 15/15

## FE (TDD)
- [x] RED: `ContractsListPage.test.tsx` CP-1b link al cliente + fixtures con `clientId`
- [x] `types/contract.ts`: `ContractSummary` += `clientId`
- [x] `ContractsListPage.tsx`: import `Link` + columna Cliente con render `<Link>`
- [x] `ContractsListPage.module.css`: `.clientLink` (patrón #47j)
- [x] GREEN: `vitest contracts` 23/23

## Gates
- [x] FE typecheck 0 err
- [x] BE `tsc --noEmit` 0 err
- [x] FE suite completa: 2292 passed; 1 flaky NO relacionado (`TaskCommentsTimeline` — pasa aislado 18/18)
