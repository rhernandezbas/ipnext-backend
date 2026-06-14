# Tasks — IClass OS Actions

> Change: `iclass-os-actions`. STRICT TDD: por cada item de código, primero el test (red), después la implementación (green), después refactor.
> Dos olas: **Ola A = Fase 2 (cierre)**, **Ola B = Fase 3 (asignación)**. Ola B arranca cuando Ola A está validada en vivo (flag flippeado).

## Ola A — Fase 2: Cerrar/validar la OS (push)

### Port + adapter
- [ ] 1. Extender `IClassPort` con `getServiceOrder(iclassId): Promise<ServiceOrderSnapshot | null>` y `closeServiceOrder(input: CloseServiceOrderInput): Promise<void>` (+ tipos `CloseServiceOrderInput`, `ServiceOrderSnapshot` reusando `ClosedServiceOrderSummary`).
- [ ] 2. (test A1-A2) `IClassClient.getServiceOrder`: GET `/serviceorders/{id}`, parsear vía `parseServiceOrderSummary`; 404/204 → null. Pasa por `withAuthRetry`.
- [ ] 3. (test A3-A5, A9) `IClassClient.closeServiceOrder`: POST `/serviceorders/close` con payload `{ serviceOrderCode, resultCode, closeDate, commentary, visibleToCustomer }`; `erros` → `IClassRejectedError`; 5xx → `IClassUnavailableError`; respuesta sin éxito esperado → `IClassUnavailableError`. `closeDate` formateada al formato IClass.
- [ ] 4. (test A6) Verificar 429 retry para close/get en `IClassClient.429.test.ts`.
- [ ] 5. Implementar `getServiceOrder` + `closeServiceOrder` en `InMemoryIClassClient` (success/reject/unavailable/already-closed programables para tests de use case).

### Errores de dominio + errorHandler
- [ ] 6. Agregar a `src/domain/errors/iclass.ts`: `IClassActionDisabledError` (409), `IClassTaskNotOpenError` (409), `IClassAlreadyClosedError` (409), `IClassNoServiceOrderError` (422).
- [ ] 7. (test R12) Agregar los códigos al `statusMap` de `errorHandler.ts` (`ICLASS_ACTION_DISABLED`→409, `ICLASS_TASK_NOT_OPEN`→409, `ICLASS_ALREADY_CLOSED`→409, `ICLASS_NO_SERVICE_ORDER`→422).

### Use case
- [ ] 8. (test C1-C11) `CloseIClassServiceOrder` use case: flag-gate → pre-checks locales (orderCode, generalStatus==='open') → resultCode en catálogo → pre-check en vivo (`getServiceOrder`, terminal/null) → `closeServiceOrder` → `generalStatus='closed'` (guard) + activity `status_changed`. Errores propagan al errorHandler.

### DTO + ruta
- [ ] 9. `iclassServiceOrderAction.dto.ts`: `CloseActionSchema` (zod: resultCode, commentary, closeDate?) + mapper a task DTO.
- [ ] 10. (test R1-R7) Ruta `POST /api/scheduling/:id/iclass/close` en `scheduling.routes.ts`, montada ANTES del catch-all `/:id`, gate `requirePerm('scheduling','iclass_close')`, validación zod → 400, errores bubble al errorHandler. Inyectar el use case vía el bag de deps IClass.

### Seed permisos + flag (Ola A)
- [x] 11. Migración seed `20260726000000_...` (parte cierre): permiso `scheduling.iclass_close` (`ON CONFLICT DO NOTHING`) + grant a `super_admin`; flag `iclass-close-action` (`featureFlag.upsert`, default **false**). Sin BEGIN/COMMIT, idempotente.
- [x] 12. Reflejar el permiso `iclass_close` en `prisma/seed.ts` (catálogo, sin grant a administrador) — paridad con `iclass_manual_resend`.

### Wiring + composition root (Ola A)
- [x] 13. (test CR1) `app.ts`: construir `CloseIClassServiceOrder` (con `buildIClassClient`, `schedulingRepo`, `iclassResultCodeRepo`, `featureFlagRepo`, recorder) e inyectarlo al scheduling router. Composition-root test verde.

### FE (Ola A)
- [ ] 14. (test FE1-FE3) Detalle de tarea: botón "Cerrar/Validar OS" visible si `iclassOrderCode && generalStatus==='open' && perm && flag`; modal (select result-code del catálogo, textarea comentario, date); manejo de 409/422 mostrando `reason`. Cliente API del endpoint nuevo.

## Ola B — Fase 3: Asignar cuadrilla (push) — empieza tras validar Ola A en vivo

### Catálogo IClassTeam (clon de IClassNode)
- [ ] 15. Entity `src/domain/entities/iclass-team.ts` (`login` UNIQUE, name, thirdPartyCode, active, selectable, timestamps).
- [ ] 16. Port `src/domain/ports/IClassTeamRepository.ts` (`list(filter)`, `getByLogin`, `upsertByLogin`, `markInactiveExcept`). Clon de `IClassNodeRepository`.
- [ ] 17. (test) `InMemoryIClassTeamRepository` (clon de InMemoryIClassNodeRepository, keyed by login).
- [x] 18. `PrismaIClassTeamRepository` (clon de PrismaIClassNodeRepository, keyed by login).
- [x] 19. Migración aditiva `20260725000000_iclass_team_catalog`: `CREATE TABLE IF NOT EXISTS "IClassTeam"` + unique index `login` + index `active`. Sin BEGIN/COMMIT. Modelo en `schema.prisma`.

### Port + adapter (teams + update)
- [ ] 20. Extender `IClassPort` con `listTeams(): Promise<IClassTeamDescriptor[]>` y `updateServiceOrder(input: UpdateServiceOrderInput): Promise<void>`.
- [ ] 21. (test A7-A8) `IClassClient.listTeams` (GET `/teams` con filtro thirdParty, mapeo login/name/thirdPartyCode) y `updateServiceOrder` (POST `/serviceorders/update` con `requiredTeam`). Vía `withAuthRetry`; errores mapeados.
- [ ] 22. Implementar `listTeams` + `updateServiceOrder` en `InMemoryIClassClient`.

### Use cases (sync + assign)
- [x] 23. (test S1-S4) `SyncIClassTeams` (clon de `SyncIClassNodes`: upsert por login, descarte vacíos, markInactiveExcept, grouping → selectable=false) + `ListIClassTeams`.
- [ ] 24. Agregar error de dominio `IClassTeamNotAssignableError` (422, `ICLASS_TEAM_NOT_ASSIGNABLE`) + entrada en `statusMap`.
- [ ] 25. (test T1-T6) `AssignIClassTeam` use case: flag-gate `iclass-assign-action` → pre-checks (orderCode, open) → team assignable → pre-check en vivo (OS no terminal) → `updateServiceOrder` → activity.

### DTO + rutas
- [x] 26. `iclassTeam.dto.ts` (TeamDTO whitelist) + `AssignTeamSchema` (zod: teamLogin).
- [x] 27. (test R8-R9) Ruta `POST /api/scheduling/:id/iclass/assign-team` (gate `scheduling.iclass_assign`, montada antes del catch-all).
- [x] 28. (test R10-R11) Router admin de teams en `/api/admin/iclass`: `GET /teams` (gate `iclass.read`), `POST /teams/sync` (gate `iclass.manage`). Clon de `iclassStatuses.routes.ts`.

### Seed permisos + flag (Ola B)
- [x] 29. Migración seed (parte asignación, en `20260726000000_...` o sufijo): permiso `scheduling.iclass_assign` + grant super_admin; flag `iclass-assign-action` default **false**. Reflejar permiso en `seed.ts`.

### Wiring + composition root (Ola B)
- [x] 30. `app.ts`: construir `AssignIClassTeam`, `SyncIClassTeams`, `ListIClassTeams`, `PrismaIClassTeamRepository`; inyectar la acción al scheduling router y montar el router de teams. Composition-root test verde.

### FE (Ola B)
- [ ] 31. (test FE4-FE5) Detalle de tarea: selector de cuadrilla (dropdown de `GET /teams` `active && selectable`) + POST assign con `teamLogin`. Página admin de teams (clon de la de status: listar + sync), gates `iclass.read`/`iclass.manage`.

## Validación entre olas (manual, no código)
- [ ] V1. Deploy Ola A con flag OFF → prueba en vivo controlada (1 OS de prueba): capturar shape real de `getServiceOrder` + `close` + `erros`; ajustar parsers si difiere; recién entonces flippear `iclass-close-action` y asignar permisos a roles operativos.
- [ ] V2. Idem para Ola B (`getServiceOrder` ya validado; validar `update` + `teams`) antes de flippear `iclass-assign-action`.

## Cierre
- [x] 32. `npm test` verde (BE) + vitest verde (FE). Verificar contrato BE↔FE no roto (endpoints existentes intactos).
