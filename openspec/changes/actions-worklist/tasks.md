# Tasks — actions-worklist

Strict TDD: test (rojo) → implementación (verde) → refactor.

## Wave 1 — Modelo + detector (BE) ✅ (2026-07-10)

- [x] 1.1 Migración aditiva `OwnershipTransferCase` (`20260902000000_ownership_transfer_case`)
- [x] 1.2 Ports `OwnershipCaseRepository` + `ContractPairingReader` (+ InMemory + Prisma + tests)
- [x] 1.3 Tests unit `DetectOwnershipTransferCases` (scenarios DET-1)
- [x] 1.4 Use case detector (pairing conservador, idempotente)
- [x] 1.5 Pata opcional del scheduler post-delta + wiring bootstrap + tests

## Wave 2 — Lecturas + router + RBAC (BE) ✅ (2026-07-10)

- [x] 2.1 `ListOwnershipCases` (checks AUTO, flip a done, DTO con nombres)
- [x] 2.2 `UpdateOwnershipCase` (union PATCH + errores tipados + statusMap)
- [x] 2.3 Port `RetirementOrderReader` + `ListRecentBajas`
- [x] 2.4 `createActionsRouter` + tests supertest (errorHandler REAL montado)
- [x] 2.5 RBAC módulo `actions` + migración `20260903000000_actions_permissions` + wiring + pins

## Wave 3 — FE ✅ (2026-07-10, worktree actions-worklist-fe)

- [x] 3.1 ui-ux-pro-max corrida antes de UI
- [x] 3.2 API + hooks (`actions.api.ts`, `useActions.ts`)
- [x] 3.3 Sidebar + ruta (antes del catch-all)
- [x] 3.4 `AccionesPage` (Tabs lazy) + `CaseChecklist` (AUTO StatusBadge + manual Can)
- [x] 3.5 1-click Transferir TV (`TransferServiceModal` + `initialTarget`/`initialTargetContractId`, callers intactos)
- [x] 3.6 Ambiguo pick + re-pick + `AssignTargetPanel` (set-target) + descarte con motivo
- [x] 3.7 Tab Bajas (DataTable + badge retiro + link a ficha)
- [x] 3.8 Tests Vitest + tsc

## Gates finales (orquestador)

- [x] G.1 Suite BE completa + tsc por el orquestador tras cada wave/fix (final: **6922** + tsc)
- [x] G.2 Review adversarial BE (2 focos) → fix wave 1 (H1 dead-ends de target ×4 patas, H2
      semántica n/a, M1 CAS flip, M2 cap, M3 proxy recientes, M4 retiro-check, M5 tests
      Prisma+bootstrap-pin+clamps, LOWs) → re-review (2 BUGS NUEVOS: resucitación de
      dismissed por repair no-CAS + starvation permanente del cap) → fix wave 2
      (`updateIfPristine` CAS + exclusión de caseadas → el cap drena) → verificación del
      orquestador sobre el código: CLEAN.
- [x] G.3 Suite FE + tsc (final: **4599** + tsc) + review FE (contrato campo a campo contra
      el BE real; 3 GAPS del PATCH extendido + HIGH tipo del PATCH + 3 MEDIUM UX) → fix
      wave FE 8/8 (AssignTargetPanel, re-pick, INVALID_TARGET_ASSIGNMENT, tipo sincerado,
      botón TV solo pending, checkbox read-only en cerrados, clamp de página, menores).
- [ ] G.4 Rebase sobre main del momento + re-gates + deploy con OK del usuario (BE primero:
      2 migraciones) + verify en vivo (Playwright: page, checklist, 1-click)

## Known-debt aceptada (documentada por los reviews, NO bloqueante)

- El PATCH devuelve la entidad de dominio (no el DTO de lectura) — el FE sinceró el tipo
  (`OwnershipCaseMutationResult`); mapear a DTO en el BE = follow-up.
- `bajaDate` siempre null hasta que el sync persista la fecha de baja de GR (follow-up).
- >500 casos prístinos 0-candidatos permanentes starvarían el repair-loop FIFO (edge teórico).
- Task de retiro antigua del MISMO contrato cuenta para el check (sin filtro temporal — aceptado).
- El ítem del sidebar cuelga del grupo Clientes (`clients.read`) — usuario con SOLO
  `actions.read` no ve la entrada aunque la ruta funcione (patrón pre-existente de Recaptación).
- `retirementOrder.taskId` expuesto pero sin link en la UI (mejora futura).
