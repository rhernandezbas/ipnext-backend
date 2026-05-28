# Verify report — iclass-so-type-mapping

**Date**: 2026-05-28
**Test status**: PASS (151 suites / 1154 passed, 9 skipped)
**Type status**: PASS (`tsc --noEmit` — no errors)
**Overall**: GO (with documented spec deviations that are intentional and internally consistent)

---

## CRITICAL

None.

---

## WARNING

### W-1: `IClassSoType` entity is missing `thirdPartyId` field (REQ-CAT-1 deviation)

The spec `iclass-so-type-catalog/spec.md` REQ-CAT-1 defines:
```ts
interface IClassSoType {
  thirdPartyId: string;
  syncedAt: string;  // spec uses syncedAt
  ...
}
```
The implementation (`src/domain/entities/iclass-so-type.ts`) omits `thirdPartyId` entirely and names the field `lastSyncedAt` (not `syncedAt`). The Prisma schema, the in-memory adapter, and all tests are aligned with the implementation. This is a documented Batch A decision (the thirdPartyId is baked into `IClassClient` as an instance field rather than passed per-call).

**Impact**: The entity does not carry `thirdPartyId` for consumers downstream; `listServiceOrderTypes()` on the port has no parameter (thirdPartyId is encapsulated in the adapter constructor per AD-2 logic). The field name mismatch `syncedAt` vs `lastSyncedAt` is cosmetic. No runtime breakage — FE must be aware that `thirdPartyId` is not in catalog responses and `syncedAt` appears as `lastSyncedAt`.

**Action**: Update the spec delta to reflect the implemented interface, OR update the entity and migrate the field. Since FE is not yet consuming the catalog shape, fixing the spec is the lower-risk path.

### W-2: `IClassPort.listServiceOrderTypes` has no `thirdPartyId` parameter (REQ-PORT-3 deviation)

Spec REQ-PORT-3 declares:
```ts
listServiceOrderTypes(thirdPartyId: string): Promise<IClassSoTypeEntry[]>
```
Implementation declares it without the parameter:
```ts
listServiceOrderTypes(): Promise<IClassSoTypeDescriptor[]>
```
The thirdPartyId is injected at construction time in `IClassClient`. This is consistent with AD-2 (adapter is a "dumb transport" that owns config). All tests call `listServiceOrderTypes()` without arguments. `InMemoryIClassClient` also implements the no-arg signature.

**Action**: Update the spec to match, OR add `thirdPartyId` as a parameter and thread it through. The current design is correct per AD-2 — the spec was not updated to reflect the refactor.

### W-3: `GET /api/admin/iclass/so-types` returns `{ items: [...] }` wrapper, not a plain array (REQ-HTTP-LIST-1 deviation)

Spec REQ-HTTP-LIST-1 states: "the body MUST be an array of `IClassSoType` objects". Implementation returns `{ items: [...] }`. All route tests assert `res.body.items`, so the tests are aligned with the implementation. The FE will need to read `.items`. This is a documented Batch C decision.

**Action**: Sync the spec OR agree this wrapper is the convention (it's already used in other list endpoints in the project). Since FE is not yet built, this is a low-risk clarification.

### W-4: REQ-SHAPE-CAT-1 does not verify `thirdPartyId` field presence

The REQ-SHAPE-CAT-1 route test (`iclass-admin.routes.test.ts:149`) checks `id, code, description, active, lastSyncedAt, createdAt, updatedAt` but does NOT assert `thirdPartyId` because it was dropped. This is consistent with W-1 but the spec still lists it as required. Not a test gap per se — the field genuinely doesn't exist.

### W-5: `IClassSoTypeRepository.markInactiveExcept` drops `thirdPartyId` parameter (REQ-CAT-2 deviation)

The spec REQ-CAT-2 defines: `markInactiveExcept(codes: string[], thirdPartyId: string): Promise<void>`. Implementation: `markInactiveExcept(presentCodes: string[]): Promise<number>`. Also the return type changed from `void` to `number` (the count is surfaced — this is actually an improvement). The `thirdPartyId` filter was dropped because the catalog doesn't scope by thirdParty. Consistent with W-1: since there's a single thirdParty, scoping by it is a no-op.

### W-6: `SyncIClassSoTypes` uses `SyncResult` shape, not `{ synced, deactivated }` from spec REQ-SYNC-1

Spec REQ-SYNC-1 says the summary MUST be `{ synced: number; deactivated: number }`. Implementation returns `{ synced, created, updated, reactivated, deactivated }` — a superset. All tests check `synced` and `deactivated` at minimum; the extra fields are harmless. The route test also asserts the extra fields exist (`created, updated, reactivated`). This is strictly additive, not a breaking deviation.

### W-7: tasks.md V-checklist items still unticked

The verify checklist at the bottom of `tasks.md` (V.1–V.9) contains unticked items — these are the manual pre-deploy checklist items, not implementation tasks. All implementation tasks (FASE 1–6) are `[x]`. The V.* items are operator gate checks, not code tasks. No action needed for merge, but document that they will be addressed during the actual prod deploy.

---

## SUGGESTION

### S-1: `IClassSoTypeRepository` port's `upsertByCode` return type in spec vs impl

Spec REQ-CAT-2 says `upsertByCode` returns `Promise<IClassSoType>`. Implementation returns `Promise<{ status: 'created' | 'updated' | 'reactivated' }>`. The richer return type is intentional (enables the sync summary). Update the spec.

### S-2: `listServiceOrderTypes` trim filter discrepancy — spec vs impl

Spec `iclass-integration/spec.md` (REQ-PORT-3 appendix) states: "Empty strings after trimming MUST be preserved as-is (not filtered)". Implementation in `IClassClient` filters out entries with empty `code` after trim. The `IClassClient.test.ts` test verifies this filtering. This is a deliberate security/quality guard, but it contradicts the spec wording. The spec should say "MUST be filtered out".

### S-3: Add `idempotency with lost mapping` test to scheduling routes

The `SendTaskToIClass.test.ts` covers the idempotency scenario at use-case level. The `scheduling.routes.test.ts` covers `REQ-SCHED-1` and `REQ-SCHED-2` via routes, but does not have an integration-level test for "task already has iclassOrderCode + project lost mapping → still moves to Registrado". This edge case is covered at unit level; a route-level test would add belt-and-suspenders coverage.

---

## REQ → test/code coverage matrix

| REQ | Spec | Test(s) | Code |
|-----|------|---------|------|
| REQ-PORT-2 | iclass-integration | `IClassClient.test.ts`: "typeSOSummary must come from input.soType"; "empty soType → throws" | `IClassClient.ts`: `buildServiceOrderPayload` + soType guard |
| REQ-PORT-3 | iclass-integration | `IClassClient.test.ts`: "maps codigo/descricao", "calls correct endpoint", "re-login on 401", "filters empty code"; `InMemoryIClassClient.test.ts`: "returns configured types" | `IClassClient.ts:100-125`; `IClassPort.ts:48` |
| REQ-CONFIG-2 | iclass-integration | `IClassClient.test.ts`: no `defaultSoType` in opts; `tsc --noEmit` clean | `IClassClient.ts` (field removed); `config.ts`; `env.example`; `deploy.yml` |
| REQ-CAT-1 | iclass-so-type-catalog | `InMemoryIClassSoTypeRepository.test.ts`; `PrismaIClassSoTypeRepository.test.ts` | `src/domain/entities/iclass-so-type.ts` (W-1: missing `thirdPartyId`, `syncedAt` → `lastSyncedAt`) |
| REQ-CAT-2 | iclass-so-type-catalog | `InMemoryIClassSoTypeRepository.test.ts`; `PrismaIClassSoTypeRepository.test.ts` | `src/domain/ports/IClassSoTypeRepository.ts` (W-5: no `thirdPartyId` param on `markInactiveExcept`) |
| REQ-SYNC-1 | iclass-so-type-catalog | `SyncIClassSoTypes.test.ts`: all 5 scenarios covered (empty, idempotent, deactivate, reactivate, IClass fails) | `src/application/use-cases/SyncIClassSoTypes.ts` |
| REQ-SYNC-2 | iclass-so-type-catalog | Not tested as explicit `thirdPartyId` injection — the thirdPartyId is baked into `IClassClient` (W-2) | `IClassClient.ts`: `thirdPartyId` from constructor opts, used in `listServiceOrderTypes` |
| REQ-LIST-CAT-1 | iclass-so-type-catalog | `ListIClassSoTypes.test.ts`: no filter → all; `{active:true}` → only active | `src/application/use-cases/ListIClassSoTypes.ts` |
| REQ-HTTP-SYNC-1 | iclass-so-type-catalog | `iclass-admin.routes.test.ts`: 200 with summary; 502 on IClass failure | `src/infrastructure/http/routes/iclass-admin.routes.ts:37-44` |
| REQ-HTTP-SYNC-2 | iclass-so-type-catalog | `iclass-admin.routes.test.ts`: 401 without token | `authMiddleware.ts` |
| REQ-HTTP-LIST-1 | iclass-so-type-catalog | `iclass-admin.routes.test.ts`: `?active=true` filters; no filter → all | `iclass-admin.routes.ts:47-69` (W-3: returns `{items:[...]}` not array) |
| REQ-HTTP-LIST-2 | iclass-so-type-catalog | `iclass-admin.routes.test.ts`: 401 without token | `authMiddleware.ts` |
| REQ-SHAPE-CAT-1 | iclass-so-type-catalog | `iclass-admin.routes.test.ts:149`: checks 7 of 8 fields (missing `thirdPartyId` — W-1) | `iclass-admin.routes.ts:57-66` |
| REQ-PROJ-1 | projects | `projects.routes.test.ts`: GET list and GET by id include `iclassSoTypeId` + `iclassSoType` | `src/domain/entities/scheduling.ts`; `PrismaProjectRepository.ts` |
| REQ-PROJ-2 | projects | `projects.routes.test.ts`: PATCH with `iclassSoTypeId` passes through | `src/application/dto/projects.dto.ts`; `UpdateProject.ts` |
| REQ-PROJ-3 | projects | `projects.routes.test.ts:189`: inactive type → 422 `ICLASS_SO_TYPE_INACTIVE`; `AssignIClassSoTypeToProject.test.ts` | `AssignIClassSoTypeToProject.ts` |
| REQ-PROJ-4 | projects | `projects.routes.test.ts:177`: non-existent id → 404; `AssignIClassSoTypeToProject.test.ts` | `AssignIClassSoTypeToProject.ts` |
| REQ-PROJ-5 | projects | `projects.routes.test.ts:157`: `null` → 200 with `iclassSoType: null` | `AssignIClassSoTypeToProject.ts:execute(id, null)` |
| REQ-PROJ-6 | projects | `projects.routes.test.ts:143`: active type → 200 with `iclassSoType.code` | `AssignIClassSoTypeToProject.ts` |
| REQ-PROJ-7 | projects | `projects.routes.test.ts:201`: numeric id → 400 `VALIDATION_ERROR` | `UpdateProjectSchema` in `projects.dto.ts` |
| REQ-PROJ-8 | projects | `projects.routes.test.ts`: GET list, GET by id, POST, PATCH all include `iclassSoTypeId` + `iclassSoType` | `PrismaProjectRepository.ts` (include iclassSoType on all selects) |
| REQ-SCHED-ERR-1 | scheduling | `SendTaskToIClass.test.ts:294`; `scheduling.routes.test.ts:1412` | `src/domain/errors/iclass.ts:MissingProjectForIClassError` |
| REQ-SCHED-ERR-2 | scheduling | `SendTaskToIClass.test.ts:302`; `scheduling.routes.test.ts:1433` | `src/domain/errors/iclass.ts:MissingIClassMappingError` |
| REQ-SCHED-1 | scheduling | `SendTaskToIClass.test.ts:294` (use case); `scheduling.routes.test.ts:1412` (route) | `SendTaskToIClass.ts` |
| REQ-SCHED-2 | scheduling | `SendTaskToIClass.test.ts:302`; `scheduling.routes.test.ts:1433` | `SendTaskToIClass.ts` |
| REQ-SCHED-3 | scheduling | `SendTaskToIClass.test.ts:313`: inactive type → `MissingIClassMappingError` | `SendTaskToIClass.ts` |
| REQ-SCHED-4 | scheduling | `SendTaskToIClass.test.ts` happy path: `soType === project.iclassSoType.code` | `SendTaskToIClass.ts:execute` |
| REQ-SCHED-5 | scheduling | `SendTaskToIClass.test.ts` flag OFF scenario | `SendTaskToIClass.ts` (flag guard before mapping check) |
| REQ-SCHED-6 | scheduling | `SendTaskToIClass.test.ts` (via `getTaskProjectMapping`); `PrismaSchedulingRepository.ts:408` | `PrismaSchedulingRepository.ts:getTaskProjectMapping` (single findUnique with project+iclassSoType includes) |

---

## Design AD adherence

- **AD-1**: ✅ `Project.iclassSoTypeId String?` with `onDelete: SetNull` confirmed in `prisma/schema.prisma:561`. Nullable as designed.
- **AD-2**: ✅ `CreateServiceOrderInput.soType: string` (required). `IClassClient` has no `defaultSoType`. `buildServiceOrderPayload` uses `input.soType`. The adapter does NOT resolve soType itself.
- **AD-3**: ✅ Soft-delete via `markInactiveExcept`. `active: false` rows are preserved. `SendTaskToIClass` validates `active` before use (throws `MissingIClassMappingError`). The FK stays valid.
- **AD-4**: ✅ `getTaskProjectMapping` is a single `findUnique` with `include: { project: { include: { iclassSoType: true } } }` — one query confirmed at `PrismaSchedulingRepository.ts:408-432`. No N+1.
- **AD-5**: ✅ Four distinct domain errors with separate HTTP codes: `MISSING_PROJECT_FOR_ICLASS → 422`, `MISSING_ICLASS_MAPPING → 422`, `ICLASS_SO_TYPE_INACTIVE → 422`, `ICLASS_SO_TYPE_NOT_FOUND → 404`. Registered in `errorHandler.ts:statusMap` and `domainErrorToCode.ts`. Extra fields (`projectTitle`, `iclassSoTypeCode`) surface in the HTTP response body.
- **AD-6**: ✅ Sync is manual (no cron). `markInactiveExcept` is a single `updateMany` (AD-6: no mutex, idempotent). Verified in `PrismaIClassSoTypeRepository.test.ts:222` ("issues a single updateMany call").
- **AD-7**: ✅ Migration `20260528000000_iclass_so_type_catalog/migration.sql` is fully additive: `ALTER TABLE "Project" ADD COLUMN "iclassSoTypeId" TEXT` + `CREATE TABLE "IClassSoType"` + 3 index creates + 1 FK add. No DROP, no DELETE, no destructive SQL. Commit `74061770` removes `ICLASS_DEFAULT_SO_TYPE` in the same batch as the code changes. Breaking change commit is present (`feat(iclass)!:`).

---

## Hexagonal purity

- `rg "from '@infrastructure" src/domain/ src/application/` → zero hits. No layer violation found.
- All use cases depend on ports only. `PrismaIClassSoTypeRepository` and `PrismaSchedulingRepository` are in `infrastructure/` and are not imported from `domain/` or `application/`.

---

## ICLASS_DEFAULT_SO_TYPE removal

- `rg "ICLASS_DEFAULT_SO_TYPE|defaultSoType" src/ env.example .github/` → only 2 hits in `src/__tests__/infrastructure/IClassClient.test.ts`, both are **comments** (lines 13 and 321: `// soType is now passed per-call — the adapter no longer has a defaultSoType`). No live code references. Clean.

---

## Migration sanity

- File: `prisma/migrations/20260528000000_iclass_so_type_catalog/migration.sql` — present.
- SQL: purely additive (`ALTER TABLE ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`, `ADD CONSTRAINT`). No `DROP`, `DELETE`, `UPDATE`, or destructive statements.
- Migration name matches the intent. Prisma schema and migration are in sync (tsc passes with the `as any` cast; full type safety will be restored once `prisma generate` runs against the live DB post-migration).

---

## Tasks completeness

All FASE 1–6 implementation tasks are `[x]`. The V.* verify checklist items (V.1–V.9) at the bottom of `tasks.md` remain unticked — these are manual operator checks to be performed during the prod deploy, not code tasks.

---

## Operator pre-deploy checklist

- [ ] Remove `ICLASS_DEFAULT_SO_TYPE` secret from GitHub Actions (Settings → Secrets)
- [ ] Remove `ICLASS_DEFAULT_SO_TYPE` env var from EasyPanel service config
- [ ] (After deploy) Call `POST /api/admin/iclass/so-types/sync` — expect `{ synced: ~26, deactivated: 0 }`
- [ ] (After sync) `GET /api/admin/iclass/so-types?active=true` — note the `id` values for each type
- [ ] (After catalog) `PATCH /api/projects/:id { iclassSoTypeId: "<id>" }` for each active Project that uses "Enviar a IClass"
- [ ] (After mapping) `GET /api/projects` — verify no active IClass-using Project has `iclassSoType: null`
- [ ] Enable flag: `PATCH /api/admin/feature-flags/iclass-integration { "enabled": true }`
- [ ] Post-activation smoke test: move a test task to "Enviar a IClass" and confirm `iclassOrderCode` is populated
