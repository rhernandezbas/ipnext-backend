# Tasks — service-transfer

Strict TDD: cada task arranca por el test (rojo) → implementación (verde) → refactor.

## Wave 1 — TV transfer (BE) ✅ (2026-07-10)

- [x] 1.1 Error de dominio `TvAlreadyLinkedError` (+ mapping HTTP en el router gigared)
- [x] 1.2 Tests unit `TransferTvToCustomer` (happy, alias-no-tomó, destino-ya-vinculado 409,
      origen-sin-TV 404, contrato ajeno 404, parcial severed/localSource/localTarget,
      sin-teardown TV-2, eventos out/in con actor)
- [x] 1.3 Use case `TransferTvToCustomer` (guard order + alias + VERIFY + severing + slots + eventos)
- [x] 1.4 Slot origen: inactivación directa con clear de credenciales (port nuevo
      `findActiveByCatalogAndNotesPrefix` + exports de la convención H2 en reconcile)
- [x] 1.5 Ruta `POST /api/gigared/customers/:id/transfer-tv` + guard `tv:transfer` + tests supertest
- [x] 1.6 RBAC: acción `transfer` en `KNOWN_ACTIONS` + test del catálogo
- [x] 1.7 Wiring `app.ts` + assertion en `gigared-composition.test.ts`

## Wave 2 — PPPoE transfer (BE) ✅ (2026-07-10)

- [x] 2.1 Tests unit `TransferPppoe` as-is
- [x] 2.2 Tests unit `TransferPppoe` recreate
- [x] 2.3 Use case `TransferPppoe` (dos modos, compone Create/Terminate)
- [x] 2.4 Ruta `POST /api/pppoe/:id/transfer` + guard + tests (+ `CONTRACT_NOT_FOUND:404` al statusMap)
- [x] 2.5 RBAC pppoe:transfer + wiring app.ts + pins composición

## Wave 3 — Equipos (BE) ✅ (2026-07-10)

- [x] 3.1 Port `transferToContract` + InMemory + Prisma + tests (condicional a status active)
- [x] 3.2 Tests unit `TransferContractEquipment`
- [x] 3.3 Use case `TransferContractEquipment` (uow transaccional legacy+ledger, rollback probado)
- [x] 3.4 Ruta `POST /api/contracts/:contractId/inventory/transfer` + guard + tests
- [x] 3.5 RBAC inventory:transfer + wiring app.ts

## Migración de permisos ✅

- [x] M.1 `20260831000000_service_transfer_permissions` — seed tv/pppoe/inventory:transfer +
      grant super_admin/administrador (data-only, idempotente, patrón tv_granular_permissions)

## Wave 4 — FE (repo ipnext-frontend, worktree service-transfer-fe) — EN CURSO

- [ ] 4.1 ui-ux-pro-max ANTES de UI
- [ ] 4.2 Modal "Transferir a otro cliente"
- [ ] 4.3 Botones por sección de servicio (Can tv/pppoe/inventory.transfer)
- [ ] 4.4 Historial: labels transfer-out/transfer-in + badge "tal cual"
- [ ] 4.5 Tests Vitest + tsc

## Gates finales (orquestador)

- [x] G.1 Suite BE completa + tsc (corridos por el orquestador tras cada wave y cada fix wave)
- [x] G.2 Review adversarial (2 revisores) → fix wave 1 (2 HIGH + 5 MEDIUM + LOWs) → re-review
      (2 BUGS NUEVOS del resume + HIGH-2 incompleto) → fix wave 2 → re-review round 2
      (cross-check solo-resume) → fix wave 3 → verificación del orquestador: CLEAN.
      Hallazgos clave: resume re-ejecutable con cross-check LOCAL de ownership incondicional
      (la verdad es local, F0); orden destino-primero para que las credenciales TV sobrevivan
      al fallo del destino; A→A guard; residuo pending del recreate con error accionable.
- [ ] G.3 Suite FE + tsc + review FE
- [ ] G.4 sdd-verify (matriz scenario→test) → deploy con OK del usuario → verify en vivo

## Known-debt aceptada (documentada por los reviews, NO bloqueante)

- Lock por cic para transferencias concurrentes del mismo origen (DistributedLock disponible).
- Guard destino-sin-pppoe-enabled es check-then-act sin constraint DB (heredado de Associate/Create).
- Semántica `ensureInternet` incondicional heredada (espejo associate/deassociate/terminate).
- Retry del recreate con OTRO username deja el pending viejo huérfano (guard 4 solo mira enabled).
- Eventos duplicados en retry/resume (rastro append-only, por diseño).
- Eventos de equipos con catálogo INTERNET invisibles en contratos sin línea INTERNET (raro; F2
  los superficia por la page Acciones).
- `cic:''` viaja en el 409 A→A (confirmar tolerancia FE en Wave 4).
