# Proposal: Auth & RBAC Foundation

## Intent

Replace the in-memory `AdminRole_Definition` + ad-hoc `Admin.role: string` model with a real persisted RBAC layer (User, Role, Permission, Module) so that every protected route can be authorized by `(module, action)` checks. This is the **data + middleware foundation** that the five follow-on SDDs (User CRUD, Role CRUD, audit log, session hardening, Admin migration) depend on.

Current pain: roles live in code, permissions are stringly-typed and not enforced, and `Admin` conflates identity with authorization. We cannot ship granular per-user module permissions until the schema exists.

## Scope

### In Scope
- New Prisma tables: `User`, `Role`, `Permission`, `Module`, `UserRole`, `RolePermission`
- Idempotent migration that seeds canonical `Module` catalog and 6 system `Role`s (`super_admin`, `administrador`, `administracion`, `ventas`, `noc`, `tecnico`) with default `Permission`s
- Domain entities + ports: `UserRepository`, `RoleRepository`, `PermissionRepository`, `UserRoleRepository`, `RolePermissionRepository`
- Prisma + InMemory adapters for each port (naming `Prisma*Repository`, `InMemory*Repository`)
- `requirePermission(module, action)` Express middleware that resolves `req.user → roles → permissions` and 403's on miss
- `User` fields: `id`, `name`, `email`, `login` (unique, used for auth), `passwordHash` (bcrypt), `status`, `createdAt`, `updatedAt`
- Coexistence with existing `Admin` table — zero changes to `admin.routes.ts` / `role.routes.ts` behavior

### Out of Scope (deferred to follow-on SDDs)
- SDD #2 — User CRUD use-cases + routes (create/edit/delete/list users, password change, role assignment UI payloads)
- SDD #3 — Role + Permission CRUD use-cases + routes
- SDD #4 — Audit middleware wiring `requirePermission` into existing routers
- SDD #5 — Session/JWT hardening, refresh tokens, password policy
- SDD #6 — `Admin` table migration/deprecation into `User`
- Any frontend work
- Modifying `app.ts` wiring beyond registering the new ports (DI only, no route mounting)

## Capabilities

### New Capabilities
- `auth-rbac`: persisted users, roles, permissions, modules; pivot tables; seed of system roles; `requirePermission` middleware

### Modified Capabilities
- None (existing `admin` + `role` capabilities remain untouched; their replacement happens in SDD #6)

## Approach

**Data model** (relations):
```
User --< UserRole >-- Role --< RolePermission >-- Permission >-- Module
```
- `Module.code` is the stable key (e.g. `clients`, `billing`, `scheduling`, `network`, `admin`, `monitoring`, `iclass`, `gestionReal`, `reports`, `tickets`, `settings`)
- `Permission` is `(moduleId, action)` where `action ∈ {read, write, delete, manage}`
- `Role.isSystem = true` for the 6 seeded roles → CRUD in SDD #3 will block deletion
- `UserRole` and `RolePermission` are pure M:N pivots with `createdAt`

**Migration strategy**:
- Single additive migration via `prisma migrate diff --from-schema --to-schema`
- Canonical catalog (Modules, Permissions, system Roles, default RolePermissions) seeded **inside the same migration** using raw SQL `INSERT ... ON CONFLICT (code) DO NOTHING` — NOT in `seed.ts` (per project convention)
- No data backfill from `Admin` (deferred to SDD #6)

**Middleware shape**:
```ts
requirePermission(module: string, action: 'read'|'write'|'delete'|'manage')
  → (req, res, next) =>
    userRepo.findById(req.user.id) → roles → permissions →
    if any permission matches (module, action) → next()
    else → 403 { error: 'FORBIDDEN', module, action }
```
Resolution is per-request; caching deferred to SDD #5.

**Coexistence with `Admin`**:
- Both tables live side-by-side. `auth.routes.ts` (JWT login) still issues tokens against `Admin` initially; a follow-on SDD switches it to `User`.
- This SDD does NOT mount `requirePermission` on any existing route — only ships it. Wiring is SDD #4.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | New | Add `User`, `Role`, `Permission`, `Module`, `UserRole`, `RolePermission` models |
| `prisma/migrations/<ts>_auth_rbac_foundation/` | New | DDL + idempotent catalog seed |
| `src/domain/entities/user.ts` | New | `User`, plus typed `PermissionAction` union |
| `src/domain/entities/rbac.ts` | New | `Role`, `Permission`, `Module` entities |
| `src/domain/ports/` | New | 5 repository interfaces |
| `src/infrastructure/adapters/prisma/` | New | 5 `Prisma*Repository` classes |
| `src/infrastructure/adapters/in-memory/` | New | 5 `InMemory*Repository` classes |
| `src/infrastructure/http/middleware/requirePermission.ts` | New | The guard |
| `src/infrastructure/http/app.ts` | Modified | Construct + register the 5 new ports in DI container (no route mounting) |
| `src/__tests__/` | New | Unit tests for middleware + in-memory adapters |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Migration runs on prod with existing `Admin` users → orphaned auth | Med | This SDD does NOT touch `auth.routes.ts` or `Admin`. Existing flow unaffected. |
| Seed migration re-runs on redeploy and duplicates rows | Med | `ON CONFLICT (code) DO NOTHING` on every insert; deterministic UUIDs or natural keys for system roles |
| Schema drift: `Module.code` values diverge from frontend strings | Med | Define enum-like constants in `domain/entities/rbac.ts` and reference from seed |
| `app.ts` DI bloat (already a 617-line God Object) | Low | Only add 5 port constructions; defer extraction to a future cleanup SDD |
| Permission resolution N+1 in middleware | Low | Single Prisma query with nested includes; doc as known, optimize in SDD #5 |

## Rollback Plan

1. Revert the migration: `prisma migrate resolve --rolled-back <migration-name>` + manually `DROP TABLE` the 6 new tables in a transactional script (no FKs point into them from existing tables, so it's safe)
2. Revert the code commit — existing `admin.routes.ts` / `role.routes.ts` / `auth.routes.ts` are untouched, so the app keeps working
3. Because `requirePermission` is never wired onto a route in this SDD, no routes break on rollback

## Dependencies

- Prisma 7 + `@prisma/adapter-pg` (already in repo)
- `bcryptjs` (already in repo)
- No new npm packages

## Success Criteria

- [ ] Migration applies cleanly on a fresh DB and on a DB that already has it (idempotent)
- [ ] All 6 system roles + their default permissions exist after migration
- [ ] `npm test` passes with new InMemory adapter tests
- [ ] `requirePermission('clients', 'read')` returns `next()` for a user with that permission and `403` for one without (unit test)
- [ ] `tsc --noEmit` clean — no `@infrastructure/*` import from `application/` or `domain/`
- [ ] Existing `admin.routes.ts`, `role.routes.ts`, `auth.routes.ts` behavior unchanged (regression tests still green)

## Open Questions

1. **`Module.code` canonical list** — is the 11-module list above (`clients, billing, scheduling, network, admin, monitoring, iclass, gestionReal, reports, tickets, settings`) the final set, or are we missing any (e.g. `crm`, `inventory`, `vehicles`)?
2. **`manage` action semantics** — does `manage` imply `read+write+delete` automatically, or is it an orthogonal "admin operations" flag (e.g. impersonate, bulk export)? Affects middleware logic.
3. **Default permissions per system role** — do we want the spec phase to define each role's permission matrix, or should the user provide a CSV/table now? (Blocking for the seed migration.)
4. **`User.login` uniqueness scope** — globally unique, or unique-per-tenant if multi-tenancy is on the horizon?
5. **Password reset / first-login flow** — out of scope confirmed, but: should `User.passwordHash` be nullable to allow "invited, not yet activated" users, or required from creation?
