# Tasks — contract-node-ap-catalog (Fase A: schema + catálogo)

**Change**: contract-node-ap-catalog · **Phase**: tasks · **Project**: ipnext-backend
**Reads**: `design.md`, `specs/contract-node-ap-catalog/spec.md`
**Convención TDD**: cada tarea de código lista el TEST primero (red → green). Jest + adapters
in-memory — NUNCA mockear Prisma. Path aliases siempre. NO `npm run build` ni `prisma migrate` (lo
decide el usuario). Los tests focalizados se corren con `npx jest <ruta>`.

**Estado**: ✅ COMPLETO (implementado en este worktree).

---

## Batch 1 — Schema + migración (aditivo)

### T1.1 — `prisma/schema.prisma` ✅
- [x] Modelo `AccessPoint` (`uispDeviceId @unique`, `networkSiteId?` → FK `SetNull`, `name`, `mac?`,
  timestamps, `contracts Contract[]`, `@@index([networkSiteId])`).
- [x] `Contract.networkSiteId?` + `Contract.accessPointId?` (FKs `SetNull`, manual-only con comentario
  "GR sync NEVER writes these", `@@index` para ambos).
- [x] Back-relations en `NetworkSite` (`accessPoints AccessPoint[]`, `contracts Contract[]`).
- [x] `npx prisma format` + `npx prisma validate` (válido; sin nombres de relación explícitos — pares
  de modelos distintos, ver design §1.3).
- [x] `npx prisma generate` (cliente tipa `prisma.accessPoint`).

### T1.2 — migración aditiva ✅
- [x] Generada con `prisma migrate diff --from-schema <HEAD> --to-schema <working> --script` (sin DB).
- [x] Revisado: solo `ADD COLUMN` / `CREATE TABLE` / índices / FKs `SET NULL`. Sin DROP/backfill.
- [x] `prisma/migrations/20260910000000_add_accesspoint_and_contract_node_ap/migration.sql` (timestamp
  posterior a la última migración `20260909000000_bulk_inbox_projection`; sin `BEGIN/COMMIT`).

## Batch 2 — Port + adapters `AccessPointRepository` (AP-1)

### T2.1 — test in-memory (RED) ✅
- [x] `src/__tests__/infrastructure/adapters/in-memory/InMemoryAccessPointRepository.test.ts` — port
  parity, upsert create/update sin duplicar, findMany, findByNetworkSiteId, findById.

### T2.2 — entity + port + impl (GREEN) ✅
- [x] `src/domain/entities/accessPoint.ts` (`AccessPoint` + `createAccessPoint`).
- [x] `src/domain/ports/AccessPointRepository.ts` (`UpsertAccessPointInput` + interface).
- [x] `src/infrastructure/adapters/in-memory/InMemoryAccessPointRepository.ts`.
- [x] `src/infrastructure/adapters/prisma/PrismaAccessPointRepository.ts` (`prisma.accessPoint.upsert`).

## Batch 3 — `SyncUispMirror` paso 9 (AP-2/AP-3/AP-4)

### T3.1 — test (RED) ✅
- [x] `src/__tests__/application/use-cases/SyncUispMirror.accesspoints.test.ts` — solo role='ap', link
  por uispSiteId, orphan → null, name/mac, idempotencia, re-link al mudarse, lista vacía no borra,
  contadores created/updated, dep opcional ausente.

### T3.2 — extender use case (GREEN) ✅
- [x] `SyncUispMirrorResult` + `accessPointsCreated`/`accessPointsUpdated`.
- [x] 6º arg opcional `accessPointRepo?: AccessPointRepository` en el constructor.
- [x] Paso 9 tras el paso 8: re-leer NetworkSites → map por uispSiteId; upsert por device role='ap';
  contar created/updated; incluir en result + JSON de SyncState.

## Batch 4 — Wiring + guards (CN-AP-1 + composition)

### T4.1 — wiring ✅
- [x] `bootstrapUispSync.ts`: `new PrismaAccessPointRepository()` como 6º arg de `SyncUispMirror`.

### T4.2 — guards (GREEN) ✅
- [x] `uisp-composition.test.ts`: port parity de `InMemoryAccessPointRepository` + pin de que
  `bootstrapUispSync.ts` pasa `PrismaAccessPointRepository` como 6º arg.
- [x] `PrismaClientMirrorRepository.upsertData.test.ts`: pins de que el data-block NO contiene
  `networkSiteId` ni `accessPointId` (manual-only, GR nunca escribe).

---

## FIX WAVE — hardening post-review adversarial (STRICT TDD)

Review adversarial encontró 4 issues + 1 de higiene sobre la Fase A ya implementada. Todos
corregidos con test-primero.

### FIX-1 [HIGH] — aislar el paso 9 en try/catch (degradación suave) ✅
- [x] TEST (RED→GREEN): `SyncUispMirror.accesspoints.fixes.test.ts` — un `accessPointRepo` que
  arroja NO aborta el sync; sites/devices persisten; `SyncState.lastResult` empieza con `ok:`;
  contadores de AP en 0; `console.warn('[uisp-sync] AP catalog step failed:', err)`.
- [x] CÓDIGO: `SyncUispMirror.ts` — TODO el paso 9 envuelto en `try/catch`; en el catch loguea
  warning y sigue (no re-throw). El `SyncState` "ok" del paso 7 SÍ se persiste aunque el catálogo
  falle (ej. tabla `AccessPoint` inexistente por deploy adelantado a la migración).

### FIX-2 [MEDIUM] — APs retirados: `missingSince` + marcado en el sync ✅
- [x] TEST port (RED→GREEN): `InMemoryAccessPointRepository.test.ts` — `missingSince` null al crear;
  `markMissing` estampa (idempotente, preserva la fecha original); `clearMissing` resetea.
- [x] TEST sync: `SyncUispMirror.accesspoints.fixes.test.ts` — device que desaparece / cambia de
  role → `missingSince` seteado; reaparece → null; lista vacía o cero role='ap' → NO marca (guard).
- [x] CÓDIGO: `missingSince DateTime?` en schema + entidad + port (`markMissing`/`clearMissing`) +
  ambos adapters (in-memory + Prisma `updateMany` chunked). Paso 9 marca/limpia espejando el step 5,
  con guard anti-truncación (`currentApDeviceIds.size > 0`) y reusando el timestamp `syncAt`.
- [x] MIGRACIÓN: regenerada con `prisma migrate diff` — `"missingSince" TIMESTAMP(3)` dentro del
  `CREATE TABLE "AccessPoint"` (migración local, no pusheada; sigue 100% aditiva).

### FIX-3 [LOW] — `role === 'ap'` case-insensitive ✅
- [x] TEST: role `'AP'` y `'Ap'` → se siembra AccessPoint; `'STATION'` no.
- [x] CÓDIGO: `(device.role ?? '').toLowerCase() === 'ap'` en el paso 9.

### FIX-4 [LOW] — counter double-count con `uispDeviceId` duplicado ✅
- [x] TEST: mismo `uispDeviceId` dos veces en la respuesta → `accessPointsCreated === 1`.
- [x] CÓDIGO: set `seen` — se cuenta una sola vez por `uispDeviceId` (el upsert sigue siendo idempotente).

### FIX-5 [higiene] — churn de `schema.prisma` ✅
- [x] Causa REAL diagnosticada: NO era LF→CRLF (el archivo ya estaba en LF en main y en el working;
  verificado con `grep`/`file`/`perl` = 0 CRLF, `core.autocrlf=true`). El churn de 911 líneas era
  la RE-ALINEACIÓN de columnas de atributos de TODO el schema que hizo `prisma format`.
- [x] Fix correcto: `git checkout main -- prisma/schema.prisma` + re-aplicar SOLO lo real a mano
  (sin `prisma format`). Diff final: **38 inserciones, 0 borrados** (antes 911). `npx prisma validate`
  OK; `npx prisma generate` OK (cliente tipa `prisma.accessPoint.missingSince`).

---

## Verificación focalizada (números reales — post FIX WAVE)
- `InMemoryAccessPointRepository.test.ts` — 11 verdes (7 base + 4 de FIX-2: missingSince/mark/clear).
- `SyncUispMirror.accesspoints.test.ts` (9) + `SyncUispMirror.accesspoints.fixes.test.ts` (8, FIX-1/2/3/4)
  + `SyncUispMirror.test.ts` + `SyncUispMirror.autoimport.test.ts` — 39 verdes (sin regresión).
- `uisp-composition.test.ts` (14) + `PrismaClientMirrorRepository.upsertData.test.ts` (9) — 23 verdes.
- Corrida conjunta AP-catálogo + UISP sync (6 suites) — 63 verdes.
- `npx tsc --noEmit` — 0 errores en el proyecto (cliente Prisma regenerado con `missingSince`).
- `git diff --stat main -- prisma/schema.prisma` — 38 inserciones, 0 borrados (churn 911→38).

## Deudas / Fases siguientes
- Fase B: rutas/use-cases de asignación contrato→nodo/AP + UI (picker). Validar AP ∈ nodo.
- Fase C: segment builder del bulk por `Contract.networkSiteId`/`accessPointId`.
- Backfill de contratos con nodo/AP existente: fuera de alcance (FKs nacen NULL).
