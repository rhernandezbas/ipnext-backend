# Tasks — contract-node-ap-auto-assign (Fase B: auto-assign + picker manual BE)

**Change**: contract-node-ap-auto-assign · **Phase**: tasks · **Project**: ipnext-backend
**Reads**: `design.md`, `specs/contract-node-ap-auto-assign/spec.md`
**Convención TDD**: cada tarea de código lista el TEST primero (red → green). Jest + adapters
in-memory — NUNCA mockear Prisma. Path aliases siempre. NO `npm run build` ni `prisma migrate` (lo
decide el usuario). Tests focalizados con `npx jest <ruta>`. Editar `schema.prisma` A MANO, sin
`prisma format` (lección FIX-5 Fase A).

**Estado**: 🟩 EN APPLY — design §14 RESUELTO (usuario + orquestador, 2026-07-16): filas 9/10 de la
matriz confirmadas tal cual propuestas, `networkSiteId: null` limpia ambos campos, permiso =
`(contracts, assign)` (reuso), AP retirado en el PATCH manual → 422, backfill de `callerId`
descartado. Roles del seed: `super_admin` + `administrador` (corrección sobre "admin" — no existe ese
`RbacRole` code; ver design §14.7 para la evidencia).

---

## Batch 1 — Normalizador de MAC (MAC-1)

### T1.1 — test (RED)
- [x] `src/__tests__/domain/services/macNormalize.test.ts` — formatos válidos convergen
  (`AA:BB:..`/`aa-bb-..`/`aabb.ccdd.eeff`/`AABBCCDDEEFF` → `aabbccddeeff`); inválidas → null
  (null, vacía, corta, no-hex, IP `100.64.28.5`).

### T1.2 — helper (GREEN)
- [x] `src/domain/services/macNormalize.ts` — `normalizeMac(input: string | null | undefined):
  string | null` (strip `[:\-.\s]`, lowercase, exactamente 12 hex o null). Función NUEVA — NO tocar
  `macSearch.ts` (semántica distinta: search parcial vs identidad canónica; documentar en el header).

## Batch 2 — Eslabón station→AP en el mirror (MIR-1, MIR-2, MIG-1)

### T2.1 — tests (RED)
- [x] `src/__tests__/infrastructure/UispClient.apdevice.test.ts` — mapDevice con
  `attributes.apDevice.id` → `apUispDeviceId`; sin `attributes`/`apDevice`/`id` → null, sin throw
  (patrón `UispClient.address.test.ts`, http inyectado).
- [x] Extender test de `InMemoryUispDeviceRepository` — upsert persiste `apUispDeviceId` y re-linkea
  en la misma fila. (+ pin de texto sobre `PrismaUispDeviceRepository.upsert` create/update.)

### T2.2 — código (GREEN)
- [x] `src/domain/entities/uisp.ts` — `apUispDeviceId: string | null` en `UispDevice` (+ JSDoc "NO
  es FK interna").
- [x] `UispClient.mapDevice` — extracción null-safe (design §3).
- [x] `PrismaUispDeviceRepository.upsert` (create + update) e `InMemoryUispDeviceRepository` —
  incluir el campo. Revisar fixtures/factories de tests existentes que construyan `UispDevice`
  (agregar el campo para que compile TS strict). 9 fixtures actualizadas en 8 archivos de test
  (uisp.test.ts x3, SyncUispMirror.*.test.ts x3, InMemoryUispClient.test.ts x2, uisp.routes.test.ts,
  GetUispSiteDetail.test.ts) — `npx tsc --noEmit` 0 errores.

### T2.3 — schema + migración
- [x] `prisma/schema.prisma` — `apUispDeviceId String?` en `UispDevice` (a mano, sin format).
- [x] `npx prisma validate` + `npx prisma generate`.
- [x] Migración con `prisma migrate diff --from-schema <HEAD> --to-schema <working> --script` →
  `prisma/migrations/20260916000000_uispdevice_ap_link/migration.sql` (solo `ADD COLUMN`, sin
  BEGIN/COMMIT).
- [x] TEST: `src/__tests__/infrastructure/migration.uispdevice_ap_link.test.ts` — SQL aditivo, sin
  DROP (patrón `migration.networksite_uisp_link.test.ts`).

## Batch 3 — Ports nuevos (CAS-1 + lectura/escritura de asignaciones)

### T3.1 — `RadiusEventRepository.latestMacByUsernames` (RED→GREEN)
- [x] TEST `src/__tests__/infrastructure/adapters/in-memory/InMemoryRadiusEventRepository.latestMac.test.ts`
  — online gana; fallback más reciente; mac null ignorada; username ausente omitido; batch.
- [x] Port + `InMemoryRadiusEventRepository` (réplica JS de la semántica).
- [x] `PrismaRadiusEventRepository` — `$queryRaw` `DISTINCT ON (username) ... ORDER BY username,
  ("stoppedAt" IS NULL) DESC, "startedAt" DESC`, `WHERE "macAddress" IS NOT NULL`, chunked 1000.

### T3.2 — `ContractRepository.getNetworkAssignments` + `updateNetworkAssignment` (RED→GREEN)
- [x] TEST sobre `InMemoryContractRepository` — proyección `{id, networkSiteId, accessPointId}`;
  ids inexistentes omitidos; update escribe/limpia SOLO esos 2 campos; null si el contrato no existe.
  (`InMemoryContractRepository.networkAssignment.test.ts`, 7 tests.)
- [x] Port (`ContractNetworkAssignmentResult`) + `InMemoryContractRepository` +
  `PrismaContractRepository` (update whitelisteado, patrón `updateLocation`). Fix de 2 mocks
  existentes de `ContractRepository` (`UpdateContractLocation.test.ts`, `UpdateContractName.test.ts`)
  para satisfacer TS strict con los 2 métodos nuevos del port.

## Batch 4 — `AutoAssignContractNetwork` (CAS-2, AA-1..AA-4)

### T4.1 — test de la matriz (RED)
- [x] `src/__tests__/application/use-cases/AutoAssignContractNetwork.test.ts` con in-memory repos
  (19 tests):
  - matriz design §6 filas 1-11 (asigna virgen; pisa manual; igual → unchanged; no-match no toca;
    sin contractId fuera; N pppoe → enabled más reciente; disabled no deriva; station missing
    excluida; AP missing se asigna igual; AP sin site escribe null).
  - desempate §6.2 (missing pierde contra viva; lastSeenAt más reciente gana; empate → ambiguous).
  - cascada §4 (callerId gana; fallback RadiusEvent; contadores `macFromCallerId`/`macFromRadiusEvent`).
  - idempotencia (2ª corrida: assigned=0, unchanged=N, 0 writes — spy sobre el repo in-memory).
  - métricas completas (universo vacío) + `SyncState('contract-network-auto-assign')` con
    `ok: {json}`; catch interno → `error: <msg>` + RE-LANZA (el scheduler decide, Batch 5).

### T4.2 — use case (GREEN)
- [x] `src/application/use-cases/AutoAssignContractNetwork.ts` — deps:
  `PppoeServiceRepository`, `RadiusEventRepository`, `UispDeviceRepository`, `AccessPointRepository`,
  `ContractRepository`, `SyncStateRepository`. Algoritmo design §5 (5 reads batch, Maps en memoria,
  writes solo-diff secuenciales). `AutoAssignContractNetworkResult` (design §7). NOTA: el universo
  "evaluado" son TODOS los contratos con ≥1 PppoeService (contractId != null), no solo los que
  tienen un candidato enabled — así un contrato con 0 pppoe enabled cuenta como `unresolved`
  (matriz fila 8), consistente con el scenario spec AA-3 "disabled no deriva".

## Batch 5 — Scheduler + wiring (AA-5)

### T5.1 — test (RED)
- [x] Extender `src/__tests__/application/UispSyncScheduler.test.ts` — con flag
  `contract-network-auto-assign` ON: invoca autoAssign tras sync exitoso (dentro del lock); OFF o
  ausente: no invoca; autoAssign que lanza: el summary del sync se reporta igual + warning; ctor sin
  autoAssign: no-op (back-compat). 5 tests nuevos. Fix de tipo pre-existente en `syncStub` (helper
  usaba `Partial<Promise<...>>` en vez de `Partial<Awaited<ReturnType<...>>>` — nunca se había
  ejercitado con un objeto de resultado hasta ahora).

### T5.2 — código (GREEN)
- [x] `UispSyncScheduler` — 6º ctor arg opcional `autoAssign?: AutoAssignContractNetwork` + step
  post-sync gated por flag, try/catch aislado (design §5).
- [x] `bootstrapUispSync.ts` — construir los repos Prisma
  (`PrismaPppoeServiceRepository`, `PrismaRadiusEventRepository`, `PrismaContractRepository`,
  reuso de `PrismaAccessPointRepository`/`PrismaUispDeviceRepository`/`PrismaSyncStateRepository`) +
  `AutoAssignContractNetwork` → pasarlo al scheduler. Solo se construye dentro del branch
  `baseUrl && token` (el scheduler ya corta en `sync===null` antes de llegar al paso auto-assign).
- [x] TEST pin: extender `uisp-composition.test.ts` — el 6º arg del scheduler no se cae en silencio
  (guard "tests verdes pero prod no asigna", patrón Fase A). 2 tests nuevos.

## Batch 6 — Picker manual: use cases (PICK-1, PICK-2)

### T6.1 — errores tipados
- [x] `src/domain/errors/networkAssignment.ts` — `NetworkSiteNotFoundError`,
  `AccessPointNotFoundError`, `AccessPointRetiredError`, `AccessPointNotInSiteError` (extienden
  `DomainError`, con `code`). No hay barrel real de errores (`domain/errors/barrel.ts` es
  `export {}`) — se importan directo del archivo, patrón del resto del proyecto. Estructural, sin
  test dedicado (triangulación skip: se ejercitan via T6.2 con instanceof + code).

### T6.2 — `SetContractNetworkAssignment` (RED→GREEN)
- [x] TEST `src/__tests__/application/use-cases/SetContractNetworkAssignment.test.ts` (11 tests) —
  tabla design §9.1 completa: 404 tipado; site/AP inexistente; AP retirado; AP∉site; autocompletar
  site desde AP; mover site limpia AP incompatible (+ caso "ya pertenece, se conserva");
  `networkSiteId: null` limpia ambos; `accessPointId: null` limpia solo AP; DTO result shape.
- [x] `src/application/use-cases/SetContractNetworkAssignment.ts` — deps: `ContractRepository`,
  `NetworkSiteRepository`, `AccessPointRepository`.

### T6.3 — `ListAssignableAccessPoints` (RED→GREEN)
- [x] TEST `src/__tests__/application/use-cases/ListAssignableAccessPoints.test.ts` (4 tests) —
  filtra `missingSince`, filtro por `networkSiteId`, orden name asc, DTO shape.
- [x] `src/application/use-cases/ListAssignableAccessPoints.ts` + DTO `AccessPointOptionDto`
  (`src/application/dto/accessPoint.dto.ts`).

## Batch 7 — Rutas + permisos (PICK-3, MIG-2)

### T7.1 — migración seed permiso
- [x] `prisma/migrations/20260916000100_contract_network_assign_permission/migration.sql` — INSERT
  `(contracts, 'assign')` + grant a `super_admin` + `administrador` (design §14.7), TODO con
  `ON CONFLICT DO NOTHING` (patrón `20260908000100_messaging_bulk_permissions`).
- [x] TEST pin del SQL (`migration.contract_network_assign_permission.test.ts`, 5 tests) — INSERT
  presente, grants a ambos roles, idempotente (ON CONFLICT en TODOS los INSERT), sin DROP/DELETE.

### T7.2 — `GET /api/access-points` (RED→GREEN)
- [x] TEST `src/__tests__/infrastructure/accessPoints.routes.test.ts` (supertest, repos in-memory,
  4 tests) — 200 `{ data: [...] }` filtrado; `?networkSiteId=`; 401 sin auth; 403 sin `network.read`.
- [x] `src/infrastructure/http/routes/accessPoints.routes.ts` —
  `createAccessPointsRouter(listAssignable, requirePerm?)`; mount en `app.ts` con
  `createAuthMiddleware` (patrón `/api/network-sites`).

### T7.3 — `PATCH /api/contracts/:id/network-assignment` (RED→GREEN)
- [x] TEST `src/__tests__/infrastructure/contracts.networkAssignment.routes.test.ts` (11 tests) —
  200 feliz; 400 body vacío/keys desconocidas (zod `.strict()` + `.refine` al-menos-una-key); 404
  contrato; 422 por cada typed error; 403 sin `contracts.assign`; 401 sin auth; 501 sin dep
  inyectada.
- [x] Extender `contracts.routes.ts` — dep opcional `setContractNetworkAssignment` (6to param) +
  zod schema + mapeo de errores (patrón EXACTO de `/contracts/:id/location`, incl. fallback
  `next(err)`).
- [x] Wiring en `app.ts` — construir el use case (`contractRepo` + `networkSiteRepo` reusados,
  `PrismaAccessPointRepository` fresco) y pasarlo al router.

## Batch 8 — Guards finales + verificación

- [ ] Correr pin de Fase A intacto (MIG-3): `PrismaClientMirrorRepository.upsertData.test.ts` (sin
  cambios esperados — solo verificación).
- [ ] Corrida conjunta focalizada: suites nuevas + `SyncUispMirror.*` + `uisp-composition` +
  scheduler (sin regresión).
- [ ] `npx tsc --noEmit` — 0 errores.
- [ ] `git diff --stat main -- prisma/schema.prisma` — SOLO la línea de `apUispDeviceId` (sin churn).

---

## Deudas / fases siguientes (fuera de este change)
- FE del picker (change coordinado en `ipnext-frontend`): dropdown nodo → AP sobre
  `GET /api/network-sites` + `GET /api/access-points` + el PATCH.
- Fase C: segment builder del bulk por `Contract.networkSiteId`/`accessPointId`.
- Acción de usuario post-deploy: correr migraciones, prender flag `contract-network-auto-assign`,
  leer métricas del primer run en `SyncState`.
- Opcional futuro: trigger manual `POST` del auto-assign + backfill de `callerId` (descartado acá,
  design §4.2).
