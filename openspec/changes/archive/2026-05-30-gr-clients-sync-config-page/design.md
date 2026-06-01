# Design — gr-clients-sync-config-page (Backend)

**Change**: `gr-clients-sync-config-page`
**Repo**: `ipnext-backend`
**Architecture**: Hexagonal (domain ← application ← infrastructure). Ports first, DTOs at the
boundary, use-cases depend only on ports.
**Template**: This change is a near-verbatim replica of `gestion-real-installation-ingest`'s config
slice, with two deltas: (a) fields are `intervalMs` + `estados` (no project FKs → no
existence-validation collaborator in `UpdateSyncConfig`), and (b) routes are RBAC-guarded.

---

## 1. `estados` storage representation — DECISION: comma-joined `String`

**Decision**: store `estados` as a single `String` column (`@default("1,2,3,4,6")`), NOT `Json` and
NOT a relation/array.

**Why**:
- The codebase ALREADY represents this exact set as a comma string in env:
  `(process.env.GR_SYNC_ESTADOS || '1,2,3,4,6').split(',')` (`config.ts:44`). Storing it the same way
  keeps the env-fallback path and the DB path byte-identical — the default record IS the env default.
- The set is tiny (≤5 codes), fixed-domain, never queried/filtered on individually. A `Json` column
  would add Prisma `JsonValue` typing friction and buys nothing here; a join table is absurd overkill
  for a 5-element enum-ish list on a single-row table.
- Postgres scalar-array (`String[]`) is an option, but the comma-string mirrors the existing env
  convention 1:1 and avoids any Prisma array-default quirks. Consistency with the established pattern
  wins.

**Boundary mapping**: the `string ⇄ string[]` conversion lives in the DTO layer
(`gestionRealSync.dto.ts`) and the repository, so the domain/DTO surface always exposes `estados` as
`string[]`. `SyncGestionRealClients` already accepts `estados?: string[]` — no change to its option
shape.

- Read: `"1,2,3,4,6"` → `split(',') → ["1","2","3","4","6"]`. Empty/whitespace → `[]` (filtered).
- Write: `["1","6"]` → `join(',') → "1,6"`.

**Allowed codes**: `1` Activo, `2` Deudor, `3` Inactivo, `4` Incobrable, `6` Baja. `5` is
intentionally excluded (matches the existing env default `1,2,3,4,6`). Zod enforces the whitelist.

---

## 2. Prisma model + migration plan

```prisma
model GestionRealSyncConfig {
  id         String   @id @default("singleton")
  intervalMs Int      @default(180000)
  estados    String   @default("1,2,3,4,6")
  updatedAt  DateTime @updatedAt
}
```

- Single-row table, keyed by the literal `"singleton"` id, identical pattern to
  `GestionRealIngestConfig`. No FKs → no `@@index`, no back-relations on `Project`.
- **Migration timestamp**: latest existing is `20260529230000_drop_admin_activity_log`. New migrations
  MUST sort AFTER it. Use:
  - `prisma/migrations/20260530000000_gr_sync_config/migration.sql` — `CREATE TABLE`.
  - `prisma/migrations/20260530010000_seed_gr_sync_flag/migration.sql` — idempotent flag seed.
- Generate the table migration additively via `prisma migrate diff` (no DB) to match the repo
  convention; never hand-edit destructively. The seed migration is hand-written SQL (a pure idempotent
  INSERT, the same as `20260529020000_seed_gr_ingest_flag`).

**Table migration SQL** (shape):
```sql
CREATE TABLE "GestionRealSyncConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "intervalMs" INTEGER NOT NULL DEFAULT 180000,
    "estados" TEXT NOT NULL DEFAULT '1,2,3,4,6',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GestionRealSyncConfig_pkey" PRIMARY KEY ("id")
);
```

---

## 3. Feature flag — read location & seed value

**Flag key**: `gestion-real-sync`.

**Read location — DECISION: inside `SyncGestionRealClients.execute()`** (NOT the scheduler tick).

- This mirrors `IngestGestionRealOrders`, which injects `FeatureFlagRepository` and checks
  `featureFlags.get('gestion-real-ingest')` as the FIRST line of `execute()`, returning a zeroed
  result when off. Putting the gate in the use-case (not the scheduler) keeps the kill switch live
  regardless of who triggers the run (scheduler tick OR a future manual trigger), and keeps the
  scheduler dumb.
- `SyncGestionRealClients` gains a `FeatureFlagRepository` constructor dependency. Per run: `const
  flag = await this.featureFlags.get('gestion-real-sync'); if (!flag?.enabled) return <skipped
  result>;` BEFORE any GR call or SyncState write. The skipped result is a `SyncRunResult` with
  `fetched/created/updated = 0` and an explicit skipped marker (extend `SyncRunResult` with an
  optional `skipped?: true` or return a zeroed result — chosen in tasks; the contract is "no GR
  call, no state write").

**Seed value — DECISION: `true`.**

- The ingest flag seeds `false` because ingest was brand-new. This sync is LIVE in prod, so seeding
  `false` would silently stop it on deploy — a regression. Seed `true` (`ON CONFLICT DO NOTHING`) so
  deploy is behavior-neutral; the flag becomes the operator's live kill switch.

**Cost note**: one extra `FeatureFlag.findUnique` per sync tick (default every 180s). Negligible vs.
the GR HTTP round-trips the sync already makes.

---

## 4. Bootstrap re-read decision — DECISION: read ONCE at bootstrap

**Decision**: `bootstrapGestionRealSync` reads the config repo ONCE (`await
syncConfig.get()`) and passes `intervalMs` to the scheduler and `estados` to the
`SyncGestionRealClients` constructor. NO per-tick re-read.

**Why**:
- Mirrors `bootstrapGestionRealIngest` exactly (`const persisted = await ingestConfig.get()` →
  `new GestionRealIngestScheduler(..., { intervalMs: persisted.intervalMs }, ...)`).
- `intervalMs` is consumed by `setInterval` at `start()` — changing it at runtime would require
  tearing down and rebuilding the timer, complexity nobody asked for. An interval/estados change
  applies on next process start. This is acceptable because the LIVE control operators need (on/off)
  is the feature flag, which IS re-read every tick.
- Avoids a DB read on the hot path every 180s for values that change rarely.

**Trade-off accepted**: editing `intervalMs`/`estados` via the endpoint does not take effect until the
next deploy/restart. Documented in the proposal's Out-of-Scope. If live interval reload is ever needed,
it's a follow-up (re-read in the scheduler tick + timer rebuild), not this change.

**Env fallback**: `bootstrapGestionRealSync` still has `config.gestionReal.intervalMs` / `.estados`
from env available. The config repo's `get()` returns the SAME defaults when no row exists, so the
two paths converge. Bootstrap prefers the repo (source of truth going forward); env remains the
hardcoded default baked into both `config.ts` and the repo defaults.

---

## 5. RBAC keys & route mounting

**Module**: `gestionReal` (already in `RbacModuleCode` catalog, `rbac.ts:77`).
**Actions**: base actions `read` and `write` (both already in `KNOWN_ACTIONS`, `rbac.ts:21-22`). No
catalog extension or migration needed.

| Route | Guard |
|-------|-------|
| `GET  /api/gestion-real/sync/config` | `requirePerm('gestionReal', 'read')` |
| `GET  /api/gestion-real/sync/status` | `requirePerm('gestionReal', 'read')` |
| `PUT  /api/gestion-real/sync/config` | `requirePerm('gestionReal', 'write')` |

- `requirePerm` is the named export already in `app.ts` (`requirePermission(rbacUserRepo, m, a)`).
  Fail-closed: unknown module / missing perm → 403; `super_admin` role short-circuits to allow.
- **Mounting**: a new router `createGestionRealSyncRouter` mounted at `/api/gestion-real/sync`. The
  existing read-only status (`createGestionRealRouter`) stays at `/api/gestion-real` (distinct path,
  no collision). The new router still applies `auth` (to populate `req.user`) BEFORE `requirePerm`
  reads `req.user.id` — order matters: `router.get('/config', auth, requirePerm('gestionReal','read'),
  handler)`.

**Note on the existing routes**: the ingest routes and the old GR sync routes use `auth` only (no
RBAC). This change does NOT retrofit them — it only adds RBAC to the NEW sync-config endpoints, as
scoped. Retrofitting the others is out of scope.

---

## 6. Use-case shapes

- `GetSyncConfig` — constructor `(config: GestionRealSyncConfigRepository)`; `execute() →
  SyncConfigDTO`. Identical to `GetIngestConfig`.
- `UpdateSyncConfig` — constructor `(config: GestionRealSyncConfigRepository)`; `execute(patch:
  UpdateSyncConfigInput) → SyncConfigDTO`. SIMPLER than `UpdateIngestConfig`: NO `ProjectRepository`,
  NO FK existence check — it's a pure partial patch (validation is the route's Zod job). `estados`
  replacement (not merge) is handled by the repo/DTO.
- Status reuses the existing `GetGestionRealSyncStatus` (unchanged).

## 7. DTO + Zod shape

```ts
export interface SyncConfigDTO { intervalMs: number; estados: string[] }

export const ALLOWED_ESTADOS = ['1','2','3','4','6'] as const;

export const UpdateSyncConfigSchema = z.object({
  intervalMs: z.number().int().positive(),
  estados: z.array(z.enum(ALLOWED_ESTADOS)),
}).partial();
```

- `toSyncConfigDTO(domain)` maps the domain `SyncConfig` (already `string[]`) straight through.
- The `string ⇄ string[]` storage conversion lives in the Prisma/in-memory adapters, NOT the DTO — the
  port's `SyncConfig` already speaks `string[]`. The DTO just guards the wire shape and never leaks
  `id`/`updatedAt`.

## 8. Layering & wiring summary

```
domain/ports/GestionRealSyncConfigRepository.ts        (SyncConfig + get/update)
   ▲                              ▲
application/use-cases/GetSyncConfig.ts, UpdateSyncConfig.ts
application/dto/gestionRealSync.dto.ts                  (SyncConfigDTO, UpdateSyncConfigSchema)
   ▲                              ▲
infra/adapters/prisma/PrismaGestionRealSyncConfigRepository.ts   (singleton upsert, string⇄array)
infra/adapters/in-memory/InMemoryGestionRealSyncConfigRepository.ts
infra/http/routes/gestionRealSync.routes.ts            (auth + requirePerm)
infra/scheduling/bootstrapGestionRealSync.ts           (read config once; wire flag into sync UC)
application/use-cases/SyncGestionRealClients.ts         (+ FeatureFlagRepository gate)
infra/http/app.ts                                       (one router wire)
```

## 9. Risks & mitigations (design-level)

| Risk | Mitigation |
|------|------------|
| Flag default stops live prod sync | Seed `true` (§3). |
| `requirePerm` runs before `auth` populates `req.user` → spurious 401 | Order middleware `auth` → `requirePerm` per route (§5). |
| `estados: []` empty array semantics | `SyncGestionRealClients` already treats empty as "no estado filter / single unfiltered scan" (`SyncGestionRealClients.ts:54`). Zod allows `[]`; behavior is the existing one. |
| Prisma client not regenerated locally for new table | Use the `(prisma as any).gestionRealSyncConfig` accessor, exactly as `PrismaGestionRealIngestConfigRepository` does. |
