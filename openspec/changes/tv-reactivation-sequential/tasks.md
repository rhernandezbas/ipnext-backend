# Tasks — tv-reactivation-sequential (#81)

## BE

- [x] 1. Domain helper `currentTvInternalId(clientId, seq)` + test (red→green).
- [x] 2. `deterministicTvEmail(lastName, grId, seq=0)` suma el seq cuando seq>0; default param mantiene back-compat + test.
- [x] 3. Schema `Client.tvActivationSeq Int @default(0)` + migración aditiva 20260714000000.
- [x] 4. Port `ClientTvActivationRepository { getSeq, incrementSeq }` + InMemory + Prisma adapters + test del InMemory.
- [x] 5. `CustomerLookup.findById` gana `tvActivationSeq?: number | null`. Prisma lookup selecciona la columna.
- [x] 6. Seam en read use cases (Get/Cancel/ChangePassword/Add/Remove/SetOtt): resolver `internalId = currentTvInternalId(...)` y usarlo en el port. Test back-compat seq=0 (idéntico) + test seq>0 (usa sufijo).
- [x] 7. `reconcileTvContractService` param opcional `internalId` (default customerId).
- [x] 8. `LinkCustomerToCic`: setInternalId/getAccountByInternalId con el internalId vigente.
- [x] 9. `RegisterGigaredAccount`: inyectar `ClientTvActivationRepository` opcional; incrementar seq SOLO en re-alta (isCancelled); generar internal_id + mail con el seq nuevo; back-compat alta normal (seq=0). Test seam completo (fake stateful: id viejo quemado, nuevo limpio).
- [x] 10. Wiring app.ts: instanciar Prisma activation repo, pasarlo a Register; lookup selecciona tvActivationSeq.
- [x] 11. Credenciales (#65): exponer internalId + email vigentes en el reader/DTO.
- [x] 12. `npx tsc --noEmit` + jest targeted gigared.

## FE

- [x] 13. Credenciales muestra internalId + mail actuales (wire contract nuevo). typecheck + vitest targeted.
