# Tasks — contract-service-history (#73)

## BE (aditivo, STRICT TDD)
- [ ] Schema: `ContractService.deactivatedAt DateTime?`
- [ ] Migration `20260711000000_contract_service_deactivated_at` (ADD COLUMN IF NOT EXISTS, no BEGIN/COMMIT)
- [ ] Port `ContractServiceView` += `deactivatedAt: string | null`
- [ ] Port `ContractServiceRepository` += `listByContract(contractId): Promise<ContractServiceView[]>`
- [ ] RED: `ListContractServiceHistory.test.ts` — devuelve activos+inactivos; vacío para contrato sin servicios
- [ ] Use case `ListContractServiceHistory.ts`
- [ ] DTO `ContractServiceHistoryItemDto` + `toContractServiceHistoryItemDto` (sin tvPassword)
- [ ] `InMemoryContractServiceRepository.listByContract` + deactivatedAt en add/update (set al inactivar, clear al reactivar)
- [ ] `PrismaContractServiceRepository.listByContract` + toView deactivatedAt + update setea deactivatedAt
- [ ] `UpdateContractService`: al pasar a inactive → deactivatedAt=now(); a active → null (vía repo)
- [ ] reconcileTvContractService: idem en paths de baja TV
- [ ] RED: `contractServiceHistory.routes.test.ts` — 200 clients.read; tvPassword AUSENTE; tvLogin presente; 401 sin auth; 403 sin permiso
- [ ] Route `GET /api/contracts/:contractId/service-history` (auth + clients.read)
- [ ] Wire en `app.ts` (inyectar use case en createContractServicesRouter)
- [ ] GREEN: jest targeted

## FE (TDD, Vitest)
- [ ] Tipo `ServiceHistoryEntry` en `src/types/customer.ts`
- [ ] `api/contract-services.api.ts` += `getContractServiceHistory(contractId)`
- [ ] Hook `useContractServiceHistory(contractId, enabled)`
- [ ] RED: `contractServiceHistory.api.test.ts`
- [ ] `ServiceHistoryModal.tsx` + `.module.css` (portal, DataTable, empty state)
- [ ] RED: `ServiceHistoryModal.test.tsx` — filas activos+inactivos, empty state, columnas
- [ ] Botón "Historial" en `ContractCard` header, gateado `<Can permission="clients.read">`
- [ ] GREEN: vitest targeted

## Gates
- [ ] BE `tsc --noEmit` 0 err
- [ ] BE jest targeted verde
- [ ] FE typecheck 0 err
- [ ] FE vitest targeted verde
