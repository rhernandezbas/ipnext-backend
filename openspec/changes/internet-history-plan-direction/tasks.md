# Tasks — internet-history-plan-direction

> STRICT TDD: RED (test primero) → GREEN (impl mínima) → refactor. Migración solo-schema; backfill aparte.

## Fase 1 — Schema + migración (aditivo)
- [x] 1. `ContractServiceEvent` += `oldPlan String?` + `newPlan String?` (`prisma/schema.prisma`)
- [x] 2. Generar SQL con `prisma migrate diff --from-schema <HEAD> --to-schema <actual> --script` (Prisma 7)
- [x] 3. Verificar que el SQL sean SOLO 2 `ADD COLUMN` nullable → `prisma/migrations/20260828000000_contract_service_event_plan_change/migration.sql`

## Fase 2 — Port + adapters (RED → GREEN)
- [x] 4. RED: `InMemoryContractServiceEventRepository.test.ts` — `record` persiste `oldPlan`/`newPlan` (null por defecto); `list` filtra por `eventType` y arrastra los campos
- [x] 5. GREEN: `ContractServiceEventRepository` port — `oldPlan?/newPlan?` en input, `oldPlan/newPlan` en entity, `eventType?` en el filtro
- [x] 6. GREEN: `InMemoryContractServiceEventRepository` — `record` graba los campos; `list` filtra por `eventType`
- [x] 7. GREEN: `PrismaContractServiceEventRepository` — `record` data, `toEvent` mapper, `where.eventType` push-down

## Fase 3 — Writers (RED → GREEN)
- [x] 8. RED: `ChangePppoePlanService.test.ts` — el evento `modified` graba `oldPlan`/`newPlan` (notes se mantiene)
- [x] 9. RED: `UpdatePppoeService.events.test.ts` — idem + caso profile original null → `oldPlan=null`
- [x] 10. GREEN: `ChangePppoePlanService.ts` + `UpdatePppoeService.ts` — agregar `oldPlan`/`newPlan` al `record` (BulkChangePlan lo hereda)

## Fase 4 — Derivación + DTO + filtros en el use case (RED → GREEN)
- [x] 11. RED: `ListInternetServiceHistory.test.ts` — derivación upgrade/downgrade/null (enforcement, missing, kbps iguales, no-modified)
- [x] 12. RED: mismo test — filtro `eventType` (push-down, assert `lastListFilter`) + filtro `direction` (independiente)
- [x] 13. GREEN: `InternetServiceEventDto` += `direction`/`oldPlan`/`newPlan`
- [x] 14. GREEN: `ListInternetServiceHistory` — inyectar `PlanRepository`, `deriveDirection`, filtros `eventType`/`direction`, `toDto`

## Fase 5 — Ruta + wiring (RED → GREEN)
- [x] 15. RED: `pppoe.internet-history.routes.test.ts` — `?eventType=modified` y `?direction=upgrade` (expone `direction`/`oldPlan`/`newPlan`)
- [x] 16. GREEN: `pppoe.routes.ts` — parsear `eventType` + `direction` en el handler de `/pppoe/activation-history`
- [x] 17. GREEN: `app.ts` — inyectar `new PrismaPlanRepository()` como 3er arg de `ListInternetServiceHistory`

## Fase 6 — Backfill
- [x] 18. `scripts/backfill-contract-service-event-plans.ts` — parsea `notes` (`" → "`, `'—'`→null), idempotente (`newPlan IS NULL`), dry-run por defecto

## Fase 7 — FE (ipnext-frontend, RED → GREEN)
- [x] 19. `types/internetService.ts` + `api/pppoe.api.ts` — 3 campos del DTO + query params `eventType`/`direction`
- [x] 20. `InternetActivationHistoryModal.tsx` + `.module.css` — 2 `<select>` (barra GLOBAL) + badge ↑/↓ + texto `oldPlan → newPlan`
- [x] 21. Vitest — selects, badge, texto, round-trip de filtros

## Gates
- [x] 22. BE: `npx jest <archivos tocados> --forceExit` verde (149/149 en el set targeted)
- [x] 23. BE: `npx tsc --noEmit` = 0 errores
- [x] 24. FE: `npx vitest run <archivos>` (67/67) + typecheck (exit 0)
- [x] 25. Migración solo-schema (2 ADD COLUMN nullable); backfill fuera de la migración
