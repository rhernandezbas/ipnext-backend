# Tasks — service-history-ledger (#110)

## BE — Schema & migración (aditivo)
- [ ] 1. Schema: modelo `ContractServiceEvent` en `prisma/schema.prisma` (id, contractId, serviceCatalogId, eventType, actorId?, actorName @default(""), notes?, createdAt, `@@index([contractId, createdAt])`, `@@map("contract_service_events")`)
- [ ] 2. Schema: relación inversa `contractServiceEvents` en `Contract` y en `RbacUser` (`@relation("ContractServiceEventActor")`)
- [ ] 3. Migración `20260722000000_add_contract_service_event/migration.sql` vía `prisma migrate diff --from-schema-datamodel <HEAD> --to-schema-datamodel prisma/schema.prisma --script` (CREATE TABLE + índice + 2 FKs; SIN BEGIN/COMMIT). Verificar SQL contra el esperado en design.md

## BE — Port & entidad
- [ ] 4. Entidad/tipos: `ServiceEventType = 'activated'|'deactivated'|'reactivated'` y `ContractServiceEvent` (read model) en `domain/entities/` o junto al port
- [ ] 5. Port `domain/ports/ContractServiceEventRepository.ts`: `record(input)` (append-only) + `listByContract(contractId): Promise<ContractServiceEvent[]>` (newest-first)
- [ ] 6. Port `TvActivationEventRepository` += `listByContract(contractId): Promise<TvActivationEvent[]>` (aditivo)

## BE — Adapters (STRICT TDD: test InMemory primero)
- [ ] 7. RED: `InMemoryContractServiceEventRepository` test (record acumula; listByContract newest-first; filtra por contractId)
- [ ] 8. `InMemoryContractServiceEventRepository.ts`
- [ ] 9. `PrismaContractServiceEventRepository.ts` (record + listByContract, mapper `toEvent`)
- [ ] 10. RED + impl: `PrismaTvActivationEventRepository.listByContract` + `InMemoryTvActivationEventRepository.listByContract` (paridad)
- [ ] 11. Test de paridad de adapters CSE (InMemory vs Prisma) si existe convención `*AdapterParity`

## BE — DTO (wire contract)
- [ ] 12. `ServiceEventDto { id, eventType, occurredAt, actorName, cic: string|null }` en `contract-services.dto.ts`
- [ ] 13. `ContractServiceHistoryItemDto` += `events: ServiceEventDto[]`; mapper `toContractServiceHistoryItemDto(view, events)` extendido (sigue SIN tvPassword)
- [ ] 14. Helper de mapeo `tvEventToServiceEvent` (alta→activated, baja→deactivated, reactivacion→reactivated; conserva cic)

## BE — Use-case de historial (STRICT TDD)
- [ ] 15. RED: `ListContractServiceHistory.test.ts` — R1.1 (no-TV 3 eventos asc), R1.2 (TV cruza con tvEvents + cic, no lee genéricos), R1.3 (legacy sintetiza de createdAt/deactivatedAt), R1.4 (sin tvPassword)
- [ ] 16. Reescribir `ListContractServiceHistory.ts`: depende de los 3 ports; cruza fuentes por `tvLogin !== null`; ordena `events` por `occurredAt` ASC; sintetiza eventos legacy

## BE — Wiring de registro best-effort (STRICT TDD)
- [ ] 17. RED: `AddContractService.test.ts` — registra `activated`; best-effort si record falla (R2.1, R2.5)
- [ ] 18. `AddContractService`: dep opcional `ContractServiceEventRepository`; record `activated` en try/catch + console.warn
- [ ] 19. RED: `UpdateContractService.test.ts` — active→inactive=`deactivated`, inactive→active=`reactivated`, solo-notes=sin evento (R2.2, R2.3)
- [ ] 20. `UpdateContractService`: leer status previo (`getById`) antes del update; comparar; record la transición; recibe `actor` por parámetro
- [ ] 21. RED: `RemoveContractService.test.ts` — activo→`deactivated`, inexistente→sin evento (R2.4)
- [ ] 22. `RemoveContractService`: `getById` antes de delete; record `deactivated` si existía y estaba active

## BE — Ruta & wiring app.ts (STRICT TDD)
- [ ] 23. Threadear actor: verificar `req.user` en `authMiddleware`; pasar `{ actorId, actorName }` a add/update/remove en `contractServices.routes.ts`
- [ ] 24. RED: `serviceHistoryLedger.routes.test.ts` — 200 con `events[]` (R3.1); 401 sin auth, 403 sin clients.read (R3.2); tvPassword ausente en todo el body (R1.4)
- [ ] 25. `app.ts`: instanciar `new PrismaContractServiceEventRepository()`; inyectar en `AddContractService`/`UpdateContractService`/`RemoveContractService`/`ListContractServiceHistory` y pasar `gigaredTvActivationEventRepo` (ya existe, línea ~1768) a `ListContractServiceHistory`
- [ ] 26. GREEN: jest targeted de todos los specs nuevos

## FE — (TDD, Vitest)
- [ ] 27. Tipo `ServiceEvent` + `ServiceHistoryEntry.events: ServiceEvent[]` en `src/types/customer.ts`
- [ ] 28. RED: `contractServiceHistory.api.test.ts` — el cliente API parsea `events`
- [ ] 29. `api/contract-services.api.ts`: tipar la respuesta con `events`
- [ ] 30. RED: `ServiceHistoryModal.test.tsx` — fila con eventos renderiza sub-secuencia (Fecha/Tipo/Operador/CIC); servicio sin eventos muestra estado actual (R5.1)
- [ ] 31. `ServiceHistoryModal.tsx`: por fila, renderizar la secuencia de eventos (sub-tabla/expandible estilo `ActivationHistoryModal`: badge Alta/Baja/Reactivación + fecha + operador + CIC para TV)
- [ ] 32. GREEN: vitest targeted

## Gates
- [ ] 33. BE `npx tsc --noEmit` 0 errores
- [ ] 34. BE jest targeted verde (use-cases + rutas + adapters)
- [ ] 35. FE typecheck 0 errores
- [ ] 36. FE vitest targeted verde
- [ ] 37. NO se ejecuta `migrate dev` contra prod (solo `migrate diff` para generar el SQL)
