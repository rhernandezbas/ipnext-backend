# Tasks — contract-node-ap-auto-assign (Fase B: auto-assign + picker manual BE)

**Change**: contract-node-ap-auto-assign · **Phase**: tasks · **Project**: ipnext-backend
**Reads**: `design.md`, `specs/contract-node-ap-auto-assign/spec.md`
**Convención TDD**: cada tarea de código lista el TEST primero (red → green). Jest + adapters
in-memory — NUNCA mockear Prisma. Path aliases siempre. NO `npm run build` ni `prisma migrate` (lo
decide el usuario). Tests focalizados con `npx jest <ruta>`. Editar `schema.prisma` A MANO, sin
`prisma format` (lección FIX-5 Fase A).

**Estado**: ✅ APPLY COMPLETO — 8/8 batches, checklist 100% marcada. design §14 RESUELTO (usuario +
orquestador, 2026-07-16): filas 9/10 de la matriz confirmadas tal cual propuestas, `networkSiteId:
null` limpia ambos campos, permiso = `(contracts, assign)` (reuso), AP retirado en el PATCH manual
→ 422, backfill de `callerId` descartado. Roles del seed: `super_admin` + `administrador`
(corrección sobre "admin" — no existe ese `RbacRole` code; ver design §14.7 para la evidencia).
Guards finales (Batch 8) verdes: pin Fase A intacto, 26 suites/206 tests del change sin regresión,
`tsc --noEmit` limpio, diff de schema mínimo. Pendiente para el orquestador: correr la suite
completa del proyecto y el rollout post-deploy (migraciones + prender el flag).

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

- [x] Correr pin de Fase A intacto (MIG-3): `PrismaClientMirrorRepository.upsertData.test.ts` — 9/9
  verdes, sin cambios (pin intacto: GR sync sigue sin escribir networkSiteId/accessPointId).
- [x] Corrida conjunta focalizada: 26 suites / 206 tests verdes — todas las suites nuevas del
  change + `SyncUispMirror.*` + `uisp-composition` + `UispSyncScheduler` + `uisp.test.ts` +
  `InMemoryUispClient` + `GetUispSiteDetail` + `UpdateContractLocation`/`UpdateContractName` +
  `contractLocation.routes` (regresión). Sin regresión.
- [x] `npx tsc --noEmit` — 0 errores (exit code 0, confirmado 2 veces consecutivas tras
  regenerar el cliente Prisma — ver nota de entorno abajo).
- [x] `git diff --stat main -- prisma/schema.prisma` — 4 líneas (1 campo + 3 de comentario JSDoc),
  SOLO `apUispDeviceId`, sin churn de formato en el resto del archivo.

**Nota de entorno (hallazgo, no bug del change)**: `node_modules` de este worktree es un symlink
COMPARTIDO con el repo principal (`ipnext-backend/node_modules`). `prisma generate` escribe al
mismo cliente compartido sin importar qué worktree lo invoque — si otro proceso/agente corre
`prisma generate` (o `npm test`/`npm run typecheck`, que lo disparan via `pretest`/`pretypecheck`)
contra OTRO schema mientras este apply está en curso, pisa el campo `apUispDeviceId` del cliente
generado y `tsc`/tests fallan con "property does not exist" sin que el código del change haya
cambiado. Pasó 2 veces durante este apply (batches 5 y 7). Mitigación aplicada: `npx prisma
generate` inmediatamente antes de cada verificación que importaba. Guardado en Engram
(`gotcha/worktree-shared-node-modules-prisma-generate`) para que el orquestador y otros agentes
lo tengan presente al correr la suite completa o trabajar en paralelo sobre otro worktree.

---

## Review — Fix Wave (post-review adversarial, 2026-07-16)

Review adversarial dejó 1 MEDIUM crítico-de-prender-flag (M1), 1 MEDIUM de cobertura (M2), LOWs y
un INFO. Fix wave en worktree dedicado (`feat/node-ap-assign`), STRICT TDD (rojo→verde) en cada punto.

- [x] **M1 — BLOQUEA prender el flag** — selección de candidato PPPoE no determinística. Root
  cause: `AutoAssignContractNetwork.ts` desempataba `createdAt` con `>` estricto (empate ⇒ "gana
  el primero de la lista") y `PrismaPppoeServiceRepository.list()` era `findMany()` SIN `orderBy`
  (orden de heap de Postgres, cambia con updates reales) ⇒ dos pppoe `enabled` del mismo
  `createdAt` (TIMESTAMP(3), típico de un ingest bulk) podían resolver a APs distintos y la
  asignación OSCILABA de tick en tick sin que cambiara ningún dato real (churn/flapping sobre
  `Contract` cada 5 min). Fix: desempate secundario ESTABLE por `id` en el use case (determinístico
  sin importar el orden de `rows`) + `orderBy: [{createdAt:'asc'},{id:'asc'}]` en
  `PrismaPppoeServiceRepository.list()` (defensa en profundidad). Test RED con un stub de
  `PppoeServiceRepository.list()` que devuelve LAS MISMAS 2 filas (mismo id, mismo createdAt) en 2
  órdenes distintas — reproducido el flapping revirtiendo el fix temporalmente (`git stash`) antes
  de confirmarlo verde. Archivos: `src/application/use-cases/AutoAssignContractNetwork.ts`,
  `src/infrastructure/adapters/prisma/PrismaPppoeServiceRepository.ts`,
  `src/__tests__/application/use-cases/AutoAssignContractNetwork.test.ts` (+1 test).

- [x] **M2 — cobertura de matriz** — 4 casos sin test ejercitados (promesa "matriz §6 completa" del
  design). Agregados a `AutoAssignContractNetwork.test.ts` (describe "cobertura de matriz faltante
  (review M2)", 4 tests): (1) station viva matchea por MAC pero `apUispDeviceId === null` →
  unresolved; (2) `apUispDeviceId` que no existe en el catálogo AccessPoint → unresolved; (3)
  device con `role != 'station'` y la MISMA MAC → excluido del match; (4) `callerId` presente pero
  INVÁLIDO (no-MAC) → cae a la cascada RadiusEvent (distinto del test pre-existente que solo cubre
  `callerId` AUSENTE). Los 4 pasan con el código de producción SIN CAMBIOS — es cobertura pura, NO
  se encontró bug oculto. Nota de proceso: la primera versión de estos tests usaba MACs con
  sufijo `M1`/`M2`/`M3`/`M4` (`M` no es hex válido) — `normalizeMac()` los rechazaba en silencio y
  3 de los 4 "pasaban" por la razón equivocada (degeneraban al caso "sin MAC", no al caso
  específico bajo prueba); corregido a sufijos hex válidos (`21`/`22`/`23`/`24`) antes de dar el
  batch por cerrado.

- [x] **L1 — `assigned++` solo si hay escritura real** — contaba `assigned++` incondicionalmente
  tras invocar `updateNetworkAssignment`, aunque el port devuelve `null` cuando el contrato no
  existe (carrera: borrado entre el read del universo y el write, o un `contractId` huérfano en
  `PppoeService`). Fix: `const updated = await ...; if (updated) assigned++;`. Test RED con un
  `contractId` nunca seedeado en `contractRepo` (universo con derivación completa pero contrato
  fantasma) — `assigned` pasaba de 1 (bug) a 0 (fix). Archivo:
  `src/application/use-cases/AutoAssignContractNetwork.ts`.

- [x] **L4 — design §7 desalineado con el código** — el comentario de `contractsEvaluated` decía
  "contratos con pppoe enabled candidato"; el código (y T4.2 de este mismo `tasks.md`) cuenta
  TODOS los contratos con ≥1 `PppoeService` (`contractId != null`), no solo los que tienen un
  candidato `enabled` — un contrato con 0 pppoe enabled SÍ cuenta y termina `unresolved` (fila 8).
  Corregido el comentario en `design.md` §7 para que documente lo que el código realmente hace (no
  al revés — el código quedó como estaba, es la semántica correcta y ya tiene test: fila 8).

- [x] **INFO(c) — `console.warn` sin mockear ensuciaba el output del test** — el test "autoAssign
  que LANZA" del scheduler no mockeaba `console.warn`, así que el catch aislado
  (`[uisp-sync] auto-assign step failed: ...`) imprimía en cada corrida. Agregado
  `jest.spyOn(console, 'warn').mockImplementation(() => undefined)` + `mockRestore()`. Archivo:
  `src/__tests__/application/UispSyncScheduler.test.ts`.

### Review — aceptados (documentados, SIN cambiar)

- **L2** — el PATCH `/contracts/:id/network-assignment` usa `createAuthMiddleware(authProvider)`
  SIN `sessionRepo` (auth stateless JWT-only, sin check de revocación). Verificado: es el patrón
  del ROUTER completo — `createContractsRouter` nunca recibe `sessionRepo`, así que TODAS las
  rutas de `contracts.routes.ts` (incl. `/contracts/:id/location`, preexistente) comparten esta
  limitación. No es específico de este change — es deuda pre-existente del router. Anotado, no se
  toca acá.
- **L3** — la cascada de MAC (§4, CAS-2) elige el evento con `macAddress` NO-NULL más reciente
  (online gana, luego `startedAt`), no "el más válido" en algún sentido semántico adicional — es
  EXACTAMENTE la especificación CAS-1/CAS-2 del design. Conforme spec, no es un bug.
- **L5** — `GET /api/access-points` no pagina. Decisión explícita design §9.2: ~544 filas hoy,
  filtro `missingSince` en memoria, "cero cambios de port". Volumen actual no lo justifica.
- **INFO(a)** — `PATCH .../network-assignment` con `networkSiteId: null` limpia AMBOS campos
  (`accessPointId` incluido) aunque el body también traiga un `accessPointId` — decisión explícita
  confirmada en design §14.3 ("desasignar el nodo desasigna el AP"). Comportamiento intencional,
  no un bug de precedencia.

---

## Deudas / fases siguientes (fuera de este change)
- FE del picker (change coordinado en `ipnext-frontend`): dropdown nodo → AP sobre
  `GET /api/network-sites` + `GET /api/access-points` + el PATCH.
- Fase C: segment builder del bulk por `Contract.networkSiteId`/`accessPointId`.
- Acción de usuario post-deploy: correr migraciones, prender flag `contract-network-auto-assign`,
  leer métricas del primer run en `SyncState`.
- Opcional futuro: trigger manual `POST` del auto-assign + backfill de `callerId` (descartado acá,
  design §4.2).
