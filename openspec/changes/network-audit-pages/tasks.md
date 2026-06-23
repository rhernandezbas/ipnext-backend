# Tasks: network-audit-pages

> EPIC de 3 repos: freeradius-orchestrator · ipnext-backend · ipnext-frontend.
> Strict TDD activo: cada tarea de implementación va precedida de su test RED. Sin test, no hay código.
> Deps críticas: Phase 0 desbloquea el seed NE8000 y la página Auditoría. Leer el design antes de arrancar.

---

## Phase 0 — Discovery (BLOQUEANTE)
> Checkpoint: las 3 preguntas respondidas y documentadas. Sin esto el seed + página ne8000-audit no se completan.
> No se escribe código de implementación hasta tener P0.2 y P0.3 confirmados.

- [ ] 0.1 **Confirmar `nasipaddress` del NE8000 en `radacct`** — conectarse a MariaDB RADIUS HA `10.75.0.10` y ejecutar `SELECT DISTINCT nasipaddress FROM radacct WHERE nasipaddress LIKE '%75%' LIMIT 20` (ajustar rango). Documentar el string exacto. Es la join key del ingest, la identidad del seed y el scope de la página ne8000-audit. **BLOQUEANTE para 2.x y 6.x** — 15m — no deps
- [ ] 0.2 **Confirmar contrato exacto de `GET /accounting`** — revisar con el dueño del orchestrator: query params (`username`, `nasIp`, `vlan`, `from`, `to`, `status`, `page`, `limit`), shape del response (`data[]`, `total`, `page`, `limit`, `hasNext`), que los octetos se retornan como números (no strings), que el orchestrator parsea `nasportid → vlan` server-side, y que `calledstationid` es omitido. Comparar contra la spec `orchestrator-accounting-endpoint`. Documentar cualquier delta. **BLOQUEANTE para 3.x (gateway)** — 30m — dep 0.1
- [ ] 0.3 **Confirmar ventana de re-scan y comportamiento HA** — preguntar: ¿cuánto tarda el max `acctstoptime` en llegar después de que una sesión cierra? ¿2h alcanza? ¿Los dos nodos HA (`r1`/`r2`) reportan bajo el mismo `nasipaddress` o por separado? Documentar. **BLOQUEANTE para 4.x (scheduler cursor)** — 20m — dep 0.1

---

## [REPO: freeradius-orchestrator] Phase 1 — Orchestrator endpoint
> Checkpoint: `GET /accounting` levantado, tests pytest verdes, contrato alineado con spec.
> Repo: freeradius-orchestrator (FastAPI, VIP `http://10.75.0.20:8080`)

- [ ] 1.1 **TDD RED**: escribir test pytest para `GET /accounting` sin token → 401 (REQ-AUTH-1) — 10m — dep 0.2
- [ ] 1.2 **TDD GREEN**: agregar bearer auth guard a la ruta `/accounting` — 15m — dep 1.1
- [ ] 1.3 **TDD RED**: test para `GET /accounting` con token válido, sin filtros → 200 + envelope `{data, total, page, limit, hasNext}` (REQ-RESP-1) — 15m — dep 1.2
- [ ] 1.4 **TDD GREEN**: implementar handler con SELECT básico sobre `radacct`, `ORDER BY acctstarttime ASC, acctuniqueid ASC`, paginado `LIMIT`/`OFFSET` — 30m — dep 1.3
- [ ] 1.5 **TDD RED**: tests para filtros `username`, `nasIp`, `from`, `to`, `status=active/closed`, `vlan` (REQ-PARAMS-2..6) — 20m — dep 1.4
- [ ] 1.6 **TDD GREEN**: aplicar filtros al SELECT de `radacct`; parsear `nasportid → vlan` con regex `vlanid==(\d+)` server-side; omitir `calledstationid` del response (REQ-RESP-3, REQ-RESP-4) — 30m — dep 1.5
- [ ] 1.7 **TDD RED**: test para `limit=10000` → responde con cap ≤ 1000 (REQ-PARAMS-8); test para `from` inválido → 400 (REQ-ERR-1) — 15m — dep 1.6
- [ ] 1.8 **TDD GREEN**: aplicar cap server-side en `limit`; validar parámetros con error 400 — 15m — dep 1.7
- [ ] 1.9 Verificar shape de `AccountingEvent` en response: campos `uniqueId`, `username`, `nasIp`, `framedIp`, `macAddress`, `startedAt`, `stoppedAt`, `sessionTime`, `bytesIn`, `bytesOut`, `vlanId`, `status` (REQ-RESP-2); `macAddress=''` → `null` — 10m — dep 1.8
- [ ] 1.10 Smoke: hit manual a `http://10.75.0.20:8080/accounting` con bearer token y verificar datos reales de `radacct` — 10m — dep 1.9

---

## [REPO: ipnext-backend] Phase 2 — Modelo de datos (RadiusEvent + NE8000 seed)
> Checkpoint: `npm run prisma:migrate` sin error + `tsc --noEmit` + suite existente verde.
> ⚠️ Dep dura: 2.6 (seed NE8000) requiere `nasipaddress` confirmada de Phase 0.1.

- [ ] 2.1 Agregar entidad de dominio `RadiusEvent` en `src/domain/entities/radius-event.ts` — interface pura sin imports de Prisma: `id, sourceUniqueId, username, nasIpAddress, nasId?, framedIp?, macAddress?, vlanId?, startedAt, stoppedAt?, sessionTime?, bytesIn (bigint), bytesOut (bigint), eventType ('start'|'stop'|'interim'), createdAt` (REQ-ENTITY-1) — 15m — no deps (pura)
- [ ] 2.2 Extender `NasType` en `src/domain/entities/nas.ts`: agregar `'huawei_radius'` a la unión (REQ-NASTYPE-1). Verificar que ningún `switch(nas.type)` rompe — agregar caso o caer en `default` — 10m — dep 2.1
- [ ] 2.3 Editar `prisma/schema.prisma`: agregar modelo `RadiusEvent` con todos los campos del design (incluye `sourceUniqueId @unique`, `nasId String?`, relation `nas NasServer? @relation(...)` con `onDelete: SetNull`, `bytesIn/bytesOut BigInt @default(0)`, `eventType String`) + back-relation `radiusEvents RadiusEvent[]` en `NasServer` (REQ-MODEL-1, REQ-MODEL-2, REQ-MIGRATION-3) — 20m — dep 2.2
- [ ] 2.4 Agregar todos los índices en `schema.prisma`: `@@index([username])`, `@@index([nasIpAddress])`, `@@index([nasId])`, `@@index([vlanId])`, `@@index([startedAt])`, `@@index([stoppedAt])`, `@@index([username, startedAt])` (REQ-INDEX-1..5) — 10m — dep 2.3
- [ ] 2.5 Generar migration aditiva: `npm run prisma:migrate` con nombre `radius_event_model`. Revisar el SQL generado: solo `CREATE TABLE "RadiusEvent"`, solo ADD back-relation, no altera `NasServer` ni otras tablas (REQ-MIGRATION-1, REQ-MIGRATION-2) — 10m — dep 2.4
- [ ] 2.6 **[BLOQUEADO en Phase 0.1]** Crear migration seed `ne8000_nas_registration`: generar con `npm run prisma:migrate` y agregar SQL manual `INSERT INTO "NasServer" (...) VALUES ('ne8000-bras-1', 'NE8000-1', 'huawei_radius', '<mgmt_IP>', '<nasipaddress_real>', 'active', 0, '...', now()) ON CONFLICT (id) DO NOTHING` con los IPs reales de Phase 0.1 (REQ-SEED-1, REQ-SEED-3). Verificar idempotencia ejecutando 2 veces — 20m — dep 0.1, dep 2.5
- [ ] 2.7 Verificar: `npm run prisma:migrate` sin error. `tsc --noEmit` → 0 errores. `npm test` → suite existente verde — 10m — dep 2.6

---

## [REPO: ipnext-backend] Phase 3 — Gateway: puerto + adaptadores
> Checkpoint: tests del gateway verdes. El puerto vive en domain/, el adaptador en infrastructure/. DIP limpio.

- [ ] 3.1 Definir tipos en `src/domain/ports/RadiusOrchestratorGateway.ts`: `AccountingFilters`, `AccountingEvent`, `AccountingPage` — tipos puros sin imports de infra (REQ-PORT-2..4). Agregar método `listAccounting(filters: AccountingFilters): Promise<AccountingPage>` a la interface (REQ-PORT-1) — 20m — dep Phase 2, dep 0.2
- [ ] 3.2 **TDD RED**: `src/__tests__/infrastructure/HttpRadiusOrchestratorGateway.listAccounting.test.ts` — fake AxiosInstance: test 200 → mapping correcto (snake→camel, `bytesIn` string→number), test filtros undefined omitidos del query string, test 4xx → `OrchestratorRejectedError`, test 5xx → `OrchestratorUnreachableError` (REQ-HTTP-1..5) — 25m — dep 3.1
- [ ] 3.3 **TDD GREEN**: extender `HttpRadiusOrchestratorGateway.ts` con `listAccounting`: serializar filtros al query string omitiendo undefined, agregar `Authorization: Bearer`, mapear response snake_case→camelCase con helper `toAccountingEvent`, parsear `bytesIn`/`bytesOut` de string/number a `number`, mappear errores (REQ-HTTP-3) — 30m — dep 3.2
- [ ] 3.4 Crear/extender `InMemoryRadiusOrchestratorGateway.ts`: implementar `listAccounting` con datos seeded, aplicar filtros `username` y `status`, retornar paginado (REQ-MEM-1, REQ-MEM-2) — 20m — dep 3.3
- [ ] 3.5 Verificar invariante DIP: `rg "from '@infrastructure" src/domain/ports/RadiusOrchestratorGateway.ts"` → 0 (REQ-DIP-1) — 2m — dep 3.4
- [ ] 3.6 `tsc --noEmit` → 0 errores. `npm test` → verde — 5m — dep 3.5

---

## [REPO: ipnext-backend] Phase 4 — Puerto RadiusEventRepository + adaptadores
> Checkpoint: port + Prisma adapter + in-memory adapter con tests verdes.

- [ ] 4.1 Crear `src/domain/ports/RadiusEventRepository.ts`: interface con `list(filters): Promise<PaginatedResult<RadiusEvent>>`, `upsertByUniqueId(rows: RadiusEventUpsert[]): Promise<number>`, `lastEventByUsername(nasId, usernames): Promise<Map<string, RadiusEvent>>`, `deleteOlderThan(cutoff: Date, batchSize: number): Promise<number>` — tipos puros sin infra (REQ-DIP-2 de radius-events-query-api) — 20m — dep Phase 2
- [ ] 4.2 **TDD RED**: `src/__tests__/application/RadiusEventRepository.contract.test.ts` usando `InMemoryRadiusEventRepository` — test `list` con filtros username/nasId/vlanId/eventType/from-to, test `upsertByUniqueId` idempotente (2 upserts del mismo `sourceUniqueId` → 1 fila, stoppedAt actualizado), test `lastEventByUsername` retorna el más reciente por username, test `deleteOlderThan` borra solo filas con `startedAt < cutoff` (REQ-INDEX del radius-event-model) — 30m — dep 4.1
- [ ] 4.3 **TDD GREEN**: crear `src/infrastructure/adapters/in-memory/InMemoryRadiusEventRepository.ts` hasta que 4.2 pase — 30m — dep 4.2
- [ ] 4.4 **TDD RED**: `src/__tests__/infrastructure/PrismaRadiusEventRepository.test.ts` (o contract test con DB test) — verifica upsert idempotente con Prisma real, `lastEventByUsername` no hace N+1 (REQ-UC-3 de ne8000-audit-api), `deleteOlderThan` borra correctamente — 20m — dep 4.3
- [ ] 4.5 **TDD GREEN**: crear `src/infrastructure/adapters/prisma/PrismaRadiusEventRepository.ts` — `upsertByUniqueId` vía `prisma.radiusEvent.upsert({ where: { sourceUniqueId }, update: {...}, create: {...} })` en batch; `lastEventByUsername` con `groupBy` o subquery (no N+1); `list` con filtros + `startedAt DESC`; `deleteOlderThan` con WHERE `startedAt < cutoff` — 40m — dep 4.4
- [ ] 4.6 Crear mapper `src/infrastructure/adapters/prisma/mappers/radiusEventMapper.ts`: `toDomain(prismaRow): RadiusEvent` — mapear `BigInt → bigint`, dates ISO, `eventType` derivado de `stoppedAt` (null→'start', notNull→'stop') — 15m — dep 4.5
- [ ] 4.7 Verificar: `rg "from '@infrastructure" src/domain/"` → 0. `tsc --noEmit` → 0. `npm test` → verde — 5m — dep 4.6

---

## [REPO: ipnext-backend] Phase 5 — Scheduler de ingest
> Checkpoint: tests del scheduler + use case IngestRadiusAccounting verdes. No toca app.ts todavía.
> Pattern de referencia: GestionRealIngestScheduler + bootstrapGestionRealIngest.

- [ ] 5.1 **TDD RED**: `src/__tests__/application/IngestRadiusAccounting.test.ts` — con `InMemoryRadiusOrchestratorGateway` (seeded con 3 AccountingEvent) + `InMemoryRadiusEventRepository` vacío: test primer run → 3 filas upsertadas, cursor avanza; test segunda run con mismo cursor → upsert actualiza stoppedAt si cambió (idempotencia, REQ-INGEST-3); test `OrchestratorUnreachableError` → no lanza, retorna error result (REQ-INGEST-6); test paginación → procesa 2 páginas si `hasNext=true` (REQ-INGEST-5) — 35m — dep Phase 3, Phase 4
- [ ] 5.2 **TDD GREEN**: crear `src/application/use-cases/IngestRadiusAccounting.ts` — leer cursor de `SyncState` (entity `radius-accounting-ingest`), calcular `since = cursor − reScanWindowMinutes`, llamar `gateway.listAccounting` en loop hasta `hasNext=false`, resolver `nasId` por `nasIpAddress` (mapa cargado 1 vez por run), upsert batch, avanzar cursor al max `startedAt` visto, persistir `SyncState.lastResult='ok'` (REQ-INGEST-1..5) — 40m — dep 5.1
- [ ] 5.3 **TDD RED**: `src/__tests__/infrastructure/RadiusAccountingIngestScheduler.test.ts` — test `inFlight` guard (2do tick no llama `IngestRadiusAccounting.run()`, REQ-SCHED-1); test lock-held skip (`DistributedLock.tryAcquire` retorna false → skip, REQ-SCHED-2); test error en run → swallowed, timer sigue vivo (REQ-SCHED-1); test `timer.unref()` llamado (REQ-SCHED-4) — 25m — dep 5.2
- [ ] 5.4 **TDD GREEN**: crear `src/infrastructure/scheduling/RadiusAccountingIngestScheduler.ts` — `setInterval` + `inFlight` guard + `DistributedLock.tryAcquire('radius-accounting-ingest')` + `runOnce()` + `timer.unref()` + error swallowing (REQ-SCHED-1..4) — 25m — dep 5.3
- [ ] 5.5 **TDD RED**: test para purga en `IngestRadiusAccounting` — con `InMemoryRadiusEventRepository` con filas de hace 13 meses: post-ingest, `deleteOlderThan(cutoff, batchSize)` debe haber sido llamado; filas recientes intactas (REQ-PURGE-1..3); test purge failure → no aborta el ingest — 20m — dep 5.4
- [ ] 5.6 **TDD GREEN**: agregar paso de purga al final de `IngestRadiusAccounting.run()` — `retentionMonths` desde env `RADIUS_EVENT_RETENTION_MONTHS` (default 12), usar `startedAt` como cursor de purga (REQ-PURGE-1, REQ-RETENTION-1 del radius-event-model); envolver en try-catch que solo loguea (REQ-PURGE-3) — 15m — dep 5.5
- [ ] 5.7 Crear `src/infrastructure/scheduling/bootstrapRadiusAccountingIngest.ts` — acepta `{ prisma, radiusGateway, lock, intervalMs=300000 }`, construye `IngestRadiusAccounting` + `RadiusAccountingIngestScheduler`, retorna null si `config.orchestrator.baseUrl` ausente (dark by default, REQ-BOOT-1) — 15m — dep 5.6
- [ ] 5.8 Verificar: `tsc --noEmit` → 0. `npm test` → verde — 5m — dep 5.7

---

## [REPO: ipnext-backend] Phase 6 — Use cases de query + DTOs + rutas
> Checkpoint: rutas `GET /radius/events` y `GET /radius/ne8000/audit` con tests supertest verdes. Read-only, sin mutaciones.
> **[BLOQUEADO parcialmente en Phase 0.1]**: `ListNe8000PppoeAudit` necesita el `nasId` del NE8000 para el scope — resuelto en runtime via lookup, no hardcoded.

- [ ] 6.1 Crear `src/application/dto/radius-event.dto.ts`: interfaces `RadiusEventDTO` y `Ne8000AuditRowDTO` tal como el design — `bytesIn/bytesOut` como `string` (BigInt→string), `online: boolean`, `nasName: string | null`; sin `sourceUniqueId` ni `password` (REQ-DTO-1, REQ-DTO-2 de ambas specs) — 15m — dep Phase 2
- [ ] 6.2 **TDD RED**: `src/__tests__/application/ListRadiusEvents.test.ts` — con `InMemoryRadiusEventRepository` pre-seeded: test filtros `username` (ILIKE), `nasId`, `vlanId`, `eventType`, `online=true/false`, `from/to`; test paginación (skip, limit cap 200); test orden `startedAt DESC`; test resultado vacío → 200 no 404 (REQ-FILTER-1..8, REQ-PAGE-1..3) — 25m — dep 6.1, Phase 4
- [ ] 6.3 **TDD GREEN**: crear `src/application/use-cases/ListRadiusEvents.ts` — depende solo de `RadiusEventRepository` port, mapea a `RadiusEventDTO` (BigInt→string, `online = stoppedAt===null`), retorna `{data, total, page, limit, hasNext}` (REQ-UC-1, REQ-UC-2, REQ-DIP-1 de radius-events-query-api) — 25m — dep 6.2
- [ ] 6.4 **TDD RED**: `src/__tests__/application/ListNe8000PppoeAudit.test.ts` — con `InMemoryPppoeServiceRepository` (nasId=NE8000) + `InMemoryRadiusEventRepository`: test scope NE8000 (MikroTik excluido, REQ-DATA-1); test `currentlyOnline=true` cuando hay RadiusEvent open (REQ-DATA-2); test `lastStartedAt/lastStoppedAt` correctos; test PPPoE sin historial → todo null/false; test filtros `username`, `status`, `enforcedState`, `online`; test orden `username ASC`; test DTO no expone `password` (REQ-DTO-2) — 30m — dep 6.1, Phase 4
- [ ] 6.5 **TDD GREEN**: crear `src/application/use-cases/ListNe8000PppoeAudit.ts` — depende de `PppoeServiceRepository` + `RadiusEventRepository` ports; resuelve NE8000 nasId por lookup (nunca hardcoded); enriquece con `lastEventByUsername` en 1 query (no N+1, REQ-UC-3); mapea a `Ne8000AuditRowDTO`; sort `username ASC`; `currentlyOnline` derivado on-read (AD-4) — 35m — dep 6.4
- [ ] 6.6 Crear `src/infrastructure/http/schemas/network-audit.schemas.ts`: zod schema para query params de `GET /radius/events` (REQ-FILTER-8: `eventType` enum, `online` boolean, `vlanId` int, `from/to` ISO) y `GET /radius/ne8000/audit` (`status` enum `enabled|disabled`, `enforcedState` enum `active|reduced|blocked`) — validación retorna 400 con `VALIDATION_ERROR` — 20m — dep 6.1
- [ ] 6.7 **TDD RED**: `src/__tests__/radius-events.routes.test.ts` — supertest con `InMemoryRadiusEventRepository` inyectado: test 401 sin token (REQ-AUTH-1), test 403 sin `network.read` (REQ-RBAC-1), test 200 con permisos + datos (REQ-PAGE-2), test 400 con `eventType=bad` (REQ-FILTER-8), test 200 vacío → body `{data:[],total:0}` no 404 (REQ-PAGE-3) — 25m — dep 6.6, Phase 4
- [ ] 6.8 **TDD GREEN**: agregar ruta `GET /radius/events` a `radius.routes.ts` (o `network-audit.routes.ts`) — guard chain `createAuthMiddleware → requirePermission('network.read') → validate(eventsQuerySchema) → handler` con `ListRadiusEvents`; SOLO GET, sin POST/DELETE (REQ-ROUTE-1, REQ-ROUTE-2) — 20m — dep 6.7
- [ ] 6.9 **TDD RED**: `src/__tests__/ne8000-audit.routes.test.ts` — supertest: test 401, test 403, test 200 scope correcto (MikroTik excluido del body), test 400 con `status=bad`, test 200 vacío → no 404 (REQ-AUTH-1, REQ-RBAC-1, REQ-PAGE-3 de ne8000-audit-api) — 20m — dep 6.5, 6.6
- [ ] 6.10 **TDD GREEN**: agregar ruta `GET /radius/ne8000/audit` a `radius.routes.ts` — mismo guard chain + `ListNe8000PppoeAudit`; SOLO GET (REQ-ROUTE-1 de ne8000-audit-api) — 15m — dep 6.9
- [ ] 6.11 Verificar DIP en use cases: `rg "from '@infrastructure" src/application/use-cases/ListRadiusEvents.ts" src/application/use-cases/ListNe8000PppoeAudit.ts"` → 0 (REQ-DIP-1 de ambas specs) — 2m — dep 6.10
- [ ] 6.12 `tsc --noEmit` → 0 errores. `npm test` → suite completa verde — 10m — dep 6.11

---

## [REPO: ipnext-backend] Phase 7 — Wiring en app.ts + main.ts (God Object flag)
> Checkpoint: scheduler registrado, rutas accesibles end-to-end. Delta mínimo en app.ts (~6–8 líneas).
> ⚠️ NO refactorizar app.ts más allá de las adiciones indicadas.

- [ ] 7.1 Editar `src/infrastructure/http/app.ts`: bajo banner `// === RADIUS accounting / network audit ===`, instanciar `PrismaRadiusEventRepository`, `ListRadiusEvents`, `ListNe8000PppoeAudit(pppoeServiceRepo, radiusEventRepo, nasRepo)` — reusar el singleton `orchestrator` existente (AD-10, REQ-BOOT-2); pasar los 2 use cases a `createRadiusRouter` (REQ-BOOT-2 del scheduler spec). Agregar `radiusAccountingIngest?: RadiusAccountingIngestScheduler | null` como param optional final de `createApp` (mismo patrón que `uispSyncScheduler`) — 20m — dep Phase 5, Phase 6
- [ ] 7.2 Editar `src/main.ts`: `const radiusAccountingIngest = await bootstrapRadiusAccountingIngest(300_000)`, pasar a `createApp(...)`, llamar `.start()` — mirrors `bootstrapUispSync` (REQ-BOOT-1) — 10m — dep 7.1
- [ ] 7.3 Smoke local end-to-end: `npm run dev`, llamar `GET /api/radius/events` y `GET /api/radius/ne8000/audit` con token válido → 200 (tablas vacías inicialmente está bien) — 10m — dep 7.2
- [ ] 7.4 `tsc --noEmit` → 0 errores. `npm test` → suite completa verde. Contar líneas agregadas en `app.ts` (esperado ≤ 10) — 10m — dep 7.3

---

## [REPO: ipnext-frontend] Phase 8 — Páginas de auditoría
> Checkpoint: 2 páginas renderizando con datos reales del BE, tests Vitest verdes, sidebar actualizado.
> ⚠️ ANTES de tocar cualquier componente: correr `ui-ux-pro-max` skill (search.py --design-system) para alinearse con el design system existente.

- [ ] 8.1 **PRE-REQUISITO**: correr skill `ui-ux-pro-max` — leer el design system del proyecto FE (tokens, componentes existentes, convenciones de Sidebar, Pagination, RequirePermission, RecaptacionPage/TicketsListPage). Documentar los patrones URL-backed filters y el componente `Pagination` para las 2 páginas — 20m — no deps de código
- [ ] 8.2 Agregar tipos TS `RadiusEventDTO` y `Ne8000AuditRowDTO` en `src/types/` (o donde viva el contrato FE↔BE) — mirrors exactos de los DTOs del BE; `bytesIn/bytesOut` como `string` — 10m — dep 8.1
- [ ] 8.3 Agregar función API `getRadiusEvents(filters, page, limit)` y `getNe8000Audit(filters, page, limit)` en la capa de API del FE — llama `GET /api/radius/events` y `GET /api/radius/ne8000/audit` respectivamente — 15m — dep 8.2
- [ ] 8.4 **TDD RED**: test Vitest para `RadiusLogsPage` — mock de `GET /radius/events`; test render tabla con columnas: Usuario, IP Asignada, MAC, VLAN, NAS, Inicio, Fin, Duración, Tipo, Estado; test filtros URL-backed (`?username=c001` → muestra filtro activo); test empty state; test loading skeleton; test NO hay botones de mutación (REQ-NOMUT-1) — 25m — dep 8.3
- [ ] 8.5 **TDD GREEN**: crear `src/pages/networking/RadiusLogsPage.tsx` + `RadiusLogsPage.filters.ts` — filtros: username (debounce 300ms), nasId (dropdown), vlanId (int input), eventType (selector), from/to (date pickers), online toggle, "Limpiar filtros"; todos URL-backed; `Pagination` component reutilizado; page resetea a 1 al cambiar filtro; sin botones de mutación (REQ-FILTER-1..8, REQ-TABLE-1..4, REQ-PAGINATION-1..2, REQ-NOMUT-1) — 60m — dep 8.4
- [ ] 8.6 **TDD RED**: test Vitest para `Ne8000AuditPage` — mock de `GET /radius/ne8000/audit`; test render tabla con columnas: Usuario, Perfil, IP Fija, IP Última Sesión, MAC, VLAN, Estado, Corte, Conexión actual, Último inicio, Último fin, Contrato (link read-only); test filtros URL-backed; test empty state; test NO hay botones de mutación (REQ-NOMUT-1) — 25m — dep 8.3
- [ ] 8.7 **TDD GREEN**: crear `src/pages/networking/Ne8000AuditPage.tsx` + `Ne8000AuditPage.filters.ts` — filtros: username (debounce), status (enabled/disabled), enforcedState (active/reduced/blocked), online toggle, "Limpiar filtros"; todos URL-backed; `Pagination`; summary header con totales (SHOULD de REQ-SUMMARY-1); contrato link read-only a `/admin/contracts/<id>`; sin botones de mutación (REQ-FILTER-1..6, REQ-TABLE-1..4, REQ-PAGINATION-1..2, REQ-NOMUT-1) — 60m — dep 8.6
- [ ] 8.8 Agregar 2 ítems al `Sidebar.tsx` bajo "Gestión de Red": `"Logs RADIUS"` → `/admin/networking/radius-logs` (`requiredPermission: 'network.read'`); `"Auditoría NE8000"` → `/admin/networking/ne8000-audit` (`requiredPermission: 'network.read'`). Verificar que NO aparecen para usuarios sin `network.read` (REQ-SIDEBAR-1..2 de ambas specs) — 15m — dep 8.5, 8.7
- [ ] 8.9 Agregar rutas al router del SPA: `/admin/networking/radius-logs` → `<RequirePermission permission='network.read'><RadiusLogsPage/></RequirePermission>`; idem para `ne8000-audit` (REQ-ROUTE-2 de ambas specs) — 15m — dep 8.8
- [ ] 8.10 `typecheck` FE → 0 errores. `vitest run` → todos los tests nuevos verdes, suite existente verde — 10m — dep 8.9

---

## Phase 9 — Verify & Deploy
> No es implementación. Son los gates de cierre del EPIC. Ejecutar en orden.

- [ ] 9.1 **Gate BE**: `npm test` (suite completa) → verde. `tsc --noEmit` → 0 errores. `rg "from '@infrastructure" src/application/use-cases/ListRadiusEvents.ts" src/application/use-cases/ListNe8000PppoeAudit.ts" src/application/use-cases/IngestRadiusAccounting.ts"` → 0 (hexagonal invariant) — dep Phase 7
- [ ] 9.2 **Gate FE**: `typecheck` → 0 errores. `vitest run` → suite completa verde — dep Phase 8
- [ ] 9.3 **Gate Orchestrator**: `pytest` → suite completa verde — dep Phase 1
- [ ] 9.4 Ejecutar `sdd-verify` contra spec de las 9 capabilities — reporta CRITICAL/WARNING/SUGGESTION — dep 9.1, 9.2, 9.3
- [ ] 9.5 **Review adversarial obligatorio** — mínimo 1 revisor focalizado en: (a) DIP violations en use cases, (b) N+1 en `lastEventByUsername`, (c) idempotencia del upsert bajo carga concurrente, (d) seguridad: ningún endpoint expone `password` ni `radiusSecret` — dep 9.4
- [ ] 9.6 **Dry-run de migraciones**: hacer rollback de `radius_event_model` y `ne8000_nas_registration` en un entorno de staging o copia de prod, verificar que no rompen datos existentes y que re-aplicar es idempotente — dep 9.5
- [ ] 9.7 **Feature flag ON**: habilitar `radius-accounting-ingest` en el flag repository. Esperar 1 tick del scheduler (5 min) y verificar en logs/`SyncState` que `lastResult='ok'` y `itemsSynced > 0` — dep 9.6
- [ ] 9.8 **Verificación Playwright en vivo**: navegar a `/admin/networking/radius-logs` y `/admin/networking/ne8000-audit` como usuario con `network.read`; confirmar que tablas renderizan datos reales, filtros funcionan URL-backed, NO hay botones de mutación visibles — dep 9.7
- [ ] 9.9 Verificar con usuario sin `network.read`: ambas páginas y ambos sidebar items están ocultos/bloqueados — dep 9.8
- [ ] 9.10 **Limpieza final**: `rg "TODO\|FIXME\|HACK" src/application/use-cases/ListRadiusEvents.ts" src/application/use-cases/ListNe8000PppoeAudit.ts" src/application/use-cases/IngestRadiusAccounting.ts"` → ningún TODO sin ticket — dep 9.9
- [ ] 9.11 **Coordinación de pushes** (3 commits independientes, en orden): (1) push freeradius-orchestrator con `GET /accounting` — esperar deploy; (2) push ipnext-backend con migraciones + scheduler + rutas — `npm run prisma:migrate` en prod, verificar; (3) push ipnext-frontend con 2 páginas. Cada push se confirma con el usuario — dep 9.10

---

## Resumen de tareas

| Bloque | Repo | Tareas | Notas |
|--------|------|--------|-------|
| Phase 0 — Discovery | — | 3 | **BLOQUEANTE** para seed NE8000 y página audit |
| Phase 1 — Orchestrator endpoint | freeradius-orchestrator | 10 | Dep Phase 0.2 |
| Phase 2 — Modelo + seed | ipnext-backend | 7 | Seed bloqueado en Phase 0.1 |
| Phase 3 — Gateway port + adapters | ipnext-backend | 6 | Dep Phase 0.2 |
| Phase 4 — RadiusEventRepository | ipnext-backend | 7 | |
| Phase 5 — Ingest scheduler | ipnext-backend | 8 | Dep Phase 0.3 (ventana re-scan) |
| Phase 6 — Use cases + rutas | ipnext-backend | 12 | Dep Phase 0.1 runtime lookup |
| Phase 7 — Wiring app.ts + main.ts | ipnext-backend | 4 | God Object flag |
| Phase 8 — Páginas FE | ipnext-frontend | 10 | Dep Phase 6 (contratos API) |
| Phase 9 — Verify & Deploy | — | 11 | |
| **TOTAL** | | **78** | |

## Tareas BLOQUEANTES de Phase 0

| Tarea | Qué bloquea |
|-------|-------------|
| 0.1 — `nasipaddress` real del NE8000 | Task 2.6 (seed migration), Task 6.4/6.5 (scope NE8000 en runtime), página ne8000-audit |
| 0.2 — Contrato `GET /accounting` | Phase 3 completa (gateway port + adapters), Phase 5 (cursor del scheduler) |
| 0.3 — Ventana re-scan + HA behavior | Task 5.1/5.2 (IngestRadiusAccounting cursor strategy, reScanWindowMinutes) |

## Batch Checkpoints para sdd-apply

| Batch | Fases | Condición de entrada |
|-------|-------|----------------------|
| Batch A | Phase 0 | Sin prerequisito — discovery puro |
| Batch B | Phase 1 | Phase 0 completa (contrato confirmado) |
| Batch C | Phase 2 | Phase 0.1 confirmada; `nasipaddress` real disponible |
| Batch D | Phase 3 + 4 | Phase 2 migración aplicada; contrato Phase 0.2 confirmado |
| Batch E | Phase 5 | Phase 3 + 4 verdes; Phase 0.3 confirmada |
| Batch F | Phase 6 | Phase 4 + 5 verdes |
| Batch G | Phase 7 | Phase 5 + 6 verdes |
| Batch H | Phase 8 | Phase 6 rutas accesibles en BE |
| Batch I | Phase 9 | Phases 7 + 8 completas; coordinación con usuario para pushes |

---
**Phase**: sdd-tasks
**Change**: network-audit-pages
**Project**: ipnext-backend
**Artifact store**: openspec
**Date**: 2026-06-22
