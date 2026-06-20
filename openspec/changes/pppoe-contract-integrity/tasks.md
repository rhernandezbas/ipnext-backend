# Tasks: PPPoE ↔ Contract Integrity

> TDD estricto (test primero). BE worktree `fix/pppoe-contract-integrity` (integrity-be).
> FE worktree `fix/pppoe-contract-integrity` (integrity-fe).

## #4 — Guard 1-PPPoE-por-contrato (BE)
- [ ] `domain/errors/pppoe.ts`: `PppoeContractAlreadyHasServiceError` (code `PPPOE_CONTRACT_ALREADY_HAS_SERVICE`).
- [ ] **(test primero)** `AssociatePppoeToContract`: contrato con PPPoE enabled → error; mismo PPPoE→mismo contrato idempotente (sin error); PPPoE disabled existente NO bloquea.
- [ ] `AssociatePppoeToContract`: guard `findByContract` → enabled tras el caso idempotente.
- [ ] **(test primero)** `CreatePppoeService` con `contractId` ocupado (enabled) → error.
- [ ] `CreatePppoeService`: guard antes de tocar la DB.
- [ ] `pppoe.routes.ts`: map `PppoeContractAlreadyHasServiceError` → 409 (associate + POST contract pppoe).

## #2 — Desasociar (BE)
- [ ] **(test primero)** `InMemoryPppoeServiceRepository.clearContractId`: contractId=null, status intacto.
- [ ] `PppoeServiceRepository` (port): `clearContractId(id)`.
- [ ] Impl in-memory + Prisma (`update {contractId:null}`).
- [ ] **(test primero)** `DeassociatePppoeFromContract`: ownership (PPPoE de otro contrato → error); éxito → contractId=null, status='enabled'.
- [ ] `DeassociatePppoeFromContract.ts` (new) + `ensureInternet(false)`.
- [ ] **(test primero)** ruta `DELETE /api/contracts/:contractId/pppoe/:pppoeId` (200/404, guard pppoe.manage).
- [ ] `pppoe.routes.ts`: ruta DELETE.

## #1 — Reconcile línea INTERNET (BE)
- [ ] **(test primero)** `EnsureInternetContractService`: crea si no existe; reactiva si inactive; inactiva si active=false; no-op+warn si no hay catálogo; best-effort (csRepo throw → no rompe).
- [ ] `EnsureInternetContractService.ts` (helper) inyectando `ContractServiceRepository` + `ServiceCatalogRepository`.
- [ ] Wire en `AssociatePppoeToContract` + `CreatePppoeService` (ensure true), `DeassociatePppoeFromContract` + `DeactivatePppoeService` (ensure false), todo best-effort (try/catch + warn).
- [ ] `app.ts`: DI del helper en los 4 use cases (+ composition test).

## FE — Desasociar
- [ ] **(test primero)** `useDeassociatePppoe` / botón "Desasociar" en `ActivePppoeView` (gate pppoe.manage).
- [ ] `usePppoe.ts`: `useDeassociatePppoe` (invalida contract-pppoe/unassigned/client-contracts).
- [ ] `pppoeApi.deassociate(contractId, pppoeId)` (DELETE).
- [ ] `InternetPanel.tsx`: botón "Desasociar" en `ActivePppoeView` (confirm) → orfana el PPPoE.

## Verificación
- [ ] BE: `npm test` verde + `tsc --noEmit` limpio. DIP: use cases no importan infra.
- [ ] FE: vitest verde + typecheck limpio.
- [ ] Seam test: ruta DELETE → use case real → repos in-memory.
- [ ] Review adversarial (obligatorio): foco en best-effort del reconcile + guard idempotente.

## Post-deploy (ops)
- [ ] Desvincular los 2 PPPoE del contrato `02c640f0`: JorgeAnllo `297606e4-acec-4c26-87ed-4da70df418e3`, JorgeVillagra `1d44bbb1-ad96-42ba-88e0-673ce694573f` (vía DELETE endpoint).
- [ ] Verificar en vivo: ficha del contrato muestra chip INTERNET tras asociar; 2º PPPoE → 409; tab Asignaciones sin los 2 Jorge tras desvincular.

## Salida
- [ ] Invariante "0 o 1 PPPoE activo por contrato" reparado, EN PROD, verificado. Data de Jorge corregida.
