# Technical Design — user-management-crud (SDD #2)

**Status**: ready
**Repos**: `ipnext-backend` + `ipnext-frontend`
**Depends on**: SDD #1 `auth-rbac-foundation` (deployed migration `20260529000000_auth_rbac_foundation`, 5 RBAC ports + adapters + InMemory, `requirePermission` middleware NOT mounted yet)
**Bound decisions**: see engram `sdd/user-management-crud/decisions` (topic key resolved as observation #342)

---

## 0. North star

Convert SDD #1's dormant RBAC plumbing into a productive surface:

1. CRUD over `RbacUser` + role-set bulk replace + explicit password change.
2. First production mount of `requirePerm('admin','manage')`.
3. Replace the legacy `AdminPage > 'admins'` tab body with `<RbacUsersBody/>` while keeping the tab id stable.
4. Bootstrap the first super_admin via env-seeded one-off script invoked from `deploy.yml` (decision #2 — pre-computed bcrypt hash, no plaintext in envs).

All ten use cases are pure (depend on ports only). Test seams: `InMemoryRbacUser*Repository` + a new in-memory `PasswordHasher` that prefixes `hashed::` so tests can assert on the stored value without paying bcrypt cost.

---

# PART A — BACKEND DESIGN

## A.1. New port: `PasswordHasher`

### A.1.1 File: `src/domain/ports/PasswordHasher.ts`

```ts
/**
 * PasswordHasher — domain port.
 *
 * Abstracts the password hashing algorithm so use cases never import bcrypt
 * directly. Tests inject a fake hasher (prefix "hashed::") for fast assertions.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or bcryptjs.
 */
export interface PasswordHasher {
  /** Returns an opaque hash string. The format is adapter-specific. */
  hash(plaintext: string): Promise<string>;

  /** Constant-time compare. Returns false on malformed hash, never throws. */
  verify(plaintext: string, hash: string): Promise<boolean>;
}
```

**Why a port (not a util)?** Use cases must not import `bcryptjs` — that breaks DIP (CLAUDE.md, repo convention). The port also lets `ChangeRbacUserPassword` swap algorithms (argon2 in SDD #6) without touching application code.

### A.1.2 Adapter: `src/infrastructure/adapters/bcrypt/BcryptPasswordHasher.ts`

```ts
import bcrypt from 'bcryptjs';
import type { PasswordHasher } from '@domain/ports/PasswordHasher';

const COST = 10; // Same factor as JwtAuthAdapter — confirmed by reading auth flow.

export class BcryptPasswordHasher implements PasswordHasher {
  async hash(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, COST);
  }
  async verify(plaintext: string, hash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(plaintext, hash);
    } catch {
      return false; // malformed hash → fail closed
    }
  }
}
```

### A.1.3 InMemory adapter (test seam): `src/infrastructure/adapters/in-memory/InMemoryPasswordHasher.ts`

```ts
import type { PasswordHasher } from '@domain/ports/PasswordHasher';

/**
 * Test-only hasher. Prefixes "hashed::" so:
 *   - tests can assert that `passwordHash` was stored hashed (not plain)
 *   - verify() is a string-equality check after stripping the prefix
 *
 * NEVER use in production — fail-fast guard could be added by reading NODE_ENV
 * but we keep it dumb: relying on DI to never wire this in main.ts.
 */
export class InMemoryPasswordHasher implements PasswordHasher {
  async hash(plaintext: string): Promise<string> {
    return `hashed::${plaintext}`;
  }
  async verify(plaintext: string, hash: string): Promise<boolean> {
    return hash === `hashed::${plaintext}`;
  }
}
```

### A.1.4 Tests

`src/__tests__/infrastructure/adapters/_shared/passwordHasherContractTests.ts` — same shared-contract pattern as the RBAC adapters (SDD #1 lifecycle, engram #307). Runs against `InMemoryPasswordHasher` always; against `BcryptPasswordHasher` always (no DB needed).

Contract: `hash(x)` is non-empty, `hash(x)` differs from `x` (no plaintext leak), `verify(x, hash(x))` is true, `verify('wrong', hash(x))` is false, `verify(x, 'malformed')` is false (no throw).

---

## A.2. Port extensions on RbacUserRepository

SDD #1 ports lack `update`, `delete`, `list`, and `countUsersWithRole`. We extend the port (additive — no breaking change).

### A.2.1 File: `src/domain/ports/RbacUserRepository.ts` (delta)

Add to the existing `RbacUserRepository` interface:

```ts
export interface UpdateRbacUserInput {
  name?: string;
  email?: string;
  status?: 'active' | 'disabled';
  // passwordHash is intentionally NOT here — changed via ChangeRbacUserPassword use case
  // login is intentionally NOT here — immutable per decision (no in-flight history yet)
}

export interface ListRbacUsersOptions {
  search?: string;       // matches name OR login OR email (case-insensitive)
  status?: 'active' | 'disabled';
}

export interface RbacUserRepository {
  // ... existing methods ...

  /** Returns all users (no pagination in v1 — admin pool is small, < 100). */
  listAll(opts?: ListRbacUsersOptions): Promise<RbacUser[]>;

  update(id: string, patch: UpdateRbacUserInput): Promise<RbacUser>;

  /** Also revokes pivot rows. Adapter does this in one transaction. */
  delete(id: string): Promise<void>;

  /** Updates passwordHash only. Separate from update() to keep auditability clean. */
  updatePasswordHash(id: string, passwordHash: string): Promise<void>;

  /** Used by last-super_admin guard. */
  countUsersWithRoleCode(roleCode: string): Promise<number>;
}
```

**Why no pagination?** SDD #2 scope explicitly says "admin pool small". Pagination is a YAGNI addition that would complicate the FE TanStack Query key surface. Add if/when needed.

**Why `countUsersWithRoleCode` on the user repo (not role repo)?** The query joins `RbacUserRole + RbacRole` and counts users — semantically it's a user count, not a role property. Keeping it close to the use case that needs it.

### A.2.2 Implementations

- `InMemoryRbacUserRepository`: extend with in-memory `update`, `delete`, `listAll`, `updatePasswordHash`, and a constructor-injected `() => RbacUserRoleRepository` to do `countUsersWithRoleCode` (we lookup the role pivot from a sibling). Alternative: pass the count as a separate test helper. **Chosen**: extend the constructor to accept optional `roleResolver: (userId) => Promise<RbacRole[]>` (already exists conceptually via `listRolesForUser`). For tests, we seed `listRolesForUser` results explicitly via `seedUserRoles(userId, roles[])`.
- `PrismaRbacUserRepository`: extend with delegated Prisma calls; `delete` uses `$transaction` to cascade-delete pivot rows then the user row (FK is `ON DELETE CASCADE` per the SDD #1 migration — confirm before tasks start; if cascade is on, the transaction is unnecessary and we just `prisma.rbacUser.delete`).

**Risk**: confirm cascade in SDD #1 migration during tasks. If absent, add `$transaction([deleteMany(pivot), delete(user)])`.

---

## A.3. DTOs — `src/application/dto/rbacUser.dto.ts`

```ts
import type { PermissionAction, RbacModuleCode } from '@domain/entities/rbac';

/**
 * Wire-shape input for creating a user. At least one roleId is required
 * (decision #3); the use case enforces this.
 */
export interface CreateRbacUserDto {
  name: string;
  email: string;
  login: string;
  password: string;           // plaintext — hashed in the use case
  status?: 'active' | 'disabled';
  roleIds: string[];          // length >= 1, enforced in use case
}

export interface UpdateRbacUserDto {
  name?: string;
  email?: string;
  status?: 'active' | 'disabled';
}

export interface ChangeRbacUserPasswordDto {
  password: string;           // plaintext, >= 8 chars
}

export interface SetRolesForUserDto {
  roleIds: string[];          // bulk replace; length >= 1
}

/**
 * Output DTO. Note: `passwordHash` is INTENTIONALLY absent.
 * Any place that needs to render the user to the wire MUST map through this type.
 */
export interface RbacUserDto {
  id: string;
  name: string;
  email: string;
  login: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface RbacRoleDto {
  id: string;
  code: string;
  label: string;
  isSystem: boolean;
}

export interface RbacUserWithRolesDto extends RbacUserDto {
  roles: RbacRoleDto[];
}

/**
 * Mappers — single source of truth for the security boundary.
 * `toRbacUserDto` MUST NOT pass through unknown fields. We explicitly enumerate.
 */
export function toRbacUserDto(u: {
  id: string; name: string; email: string; login: string;
  status: 'active' | 'disabled';
  createdAt: string; updatedAt: string; lastLoginAt: string | null;
}): RbacUserDto {
  return {
    id: u.id, name: u.name, email: u.email, login: u.login,
    status: u.status, createdAt: u.createdAt, updatedAt: u.updatedAt,
    lastLoginAt: u.lastLoginAt,
  };
}

export function toRbacRoleDto(r: {
  id: string; code: string; label: string; isSystem: boolean;
}): RbacRoleDto {
  return { id: r.id, code: r.code, label: r.label, isSystem: r.isSystem };
}
```

**Type-level guarantee**: `RbacUserDto` has NO `passwordHash` field. Trying `as RbacUserDto` on an entity that has `passwordHash` is fine (the field is just dropped) — but any consumer that types its response as `RbacUserDto` cannot leak the field. We additionally add a runtime snapshot test that JSON-serializes the response and asserts `'passwordHash' not in keys`.

---

## A.4. Use case file layout — `src/application/use-cases/rbac/`

Each file: one class, one `execute(input)` method. Constructor injects ports.

| File | Inputs | Output | Errors thrown |
|---|---|---|---|
| `ListRbacUsers.ts` | `{ search?, status? }` | `RbacUserDto[]` | — |
| `GetRbacUser.ts` | `{ id }` | `RbacUserWithRolesDto` | `RbacUserNotFoundError` |
| `CreateRbacUser.ts` | `CreateRbacUserDto` | `RbacUserWithRolesDto` | `LoginAlreadyTakenError`, `EmailAlreadyTakenError`, `RbacRoleNotFoundError`, `AtLeastOneRoleRequiredError`, `PasswordTooShortError` |
| `UpdateRbacUser.ts` | `{ id, patch: UpdateRbacUserDto }` | `RbacUserDto` | `RbacUserNotFoundError`, `EmailAlreadyTakenError` |
| `DeleteRbacUser.ts` | `{ id, actingUserId }` | `void` | `RbacUserNotFoundError`, `CannotDeleteSelfError`, `CannotRemoveLastSuperAdminError` |
| `ChangeRbacUserPassword.ts` | `{ id, password }` | `void` | `RbacUserNotFoundError`, `PasswordTooShortError` |
| `ListRolesForUser.ts` | `{ id }` | `RbacRoleDto[]` | `RbacUserNotFoundError` |
| `SetRolesForUser.ts` | `{ id, roleIds, actingUserId }` | `RbacRoleDto[]` | `RbacUserNotFoundError`, `RbacRoleNotFoundError`, `AtLeastOneRoleRequiredError`, `CannotRemoveLastSuperAdminError` |
| `AssignRoleToUser.ts` | `{ userId, roleId }` | `void` | `RbacUserNotFoundError`, `RbacRoleNotFoundError` |
| `RemoveRoleFromUser.ts` | `{ userId, roleId, actingUserId }` | `void` | `RbacUserNotFoundError`, `RbacRoleNotFoundError`, `CannotRemoveLastSuperAdminError`, `AtLeastOneRoleRequiredError` |

Domain errors live in `src/domain/errors/rbacUser.errors.ts`:

```ts
export class RbacUserNotFoundError extends Error { code = 'RBAC_USER_NOT_FOUND'; }
export class LoginAlreadyTakenError extends Error { code = 'LOGIN_ALREADY_TAKEN'; }
export class EmailAlreadyTakenError extends Error { code = 'EMAIL_ALREADY_TAKEN'; }
export class RbacRoleNotFoundError extends Error { code = 'RBAC_ROLE_NOT_FOUND'; }
export class AtLeastOneRoleRequiredError extends Error { code = 'AT_LEAST_ONE_ROLE_REQUIRED'; }
export class CannotDeleteSelfError extends Error { code = 'CANNOT_DELETE_SELF'; }
export class CannotRemoveLastSuperAdminError extends Error { code = 'CANNOT_REMOVE_LAST_SUPER_ADMIN'; }
export class PasswordTooShortError extends Error { code = 'PASSWORD_TOO_SHORT'; }
```

### A.4.1 `CreateRbacUser` flow

```
1. Validate password.length >= 8 → PasswordTooShortError
2. Validate roleIds.length >= 1 → AtLeastOneRoleRequiredError
3. For each roleId: rbacRoleRepo.findById → RbacRoleNotFoundError
4. rbacUserRepo.findByLogin(login) → LoginAlreadyTakenError if hit
5. rbacUserRepo.findByEmail(email) → EmailAlreadyTakenError if hit
6. passwordHash = hasher.hash(password)
7. user = rbacUserRepo.create({ name, email, login, passwordHash, status })
8. For each roleId: rbacUserRoleRepo.assign(user.id, roleId)
9. roles = roleIds resolved → toRbacRoleDto
10. return { ...toRbacUserDto(user), roles }
```

Race condition (two concurrent creates with same login): caught by DB unique constraint on `login` (SDD #1 schema). The use case's check is best-effort; the adapter must wrap `create` to translate Prisma P2002 on `login` → `LoginAlreadyTakenError`, on `email` → `EmailAlreadyTakenError`. Document this on the `PrismaRbacUserRepository.create` method.

### A.4.2 `DeleteRbacUser` flow (last-super_admin guard)

```
1. If id === actingUserId → CannotDeleteSelfError
2. user = rbacUserRepo.findById(id) || RbacUserNotFoundError
3. roles = rbacUserRepo.listRolesForUser(id)
4. If roles.some(r.code === 'super_admin'):
     count = rbacUserRepo.countUsersWithRoleCode('super_admin')
     if (count <= 1) → CannotRemoveLastSuperAdminError
5. rbacUserRepo.delete(id)  // cascades pivot rows
```

### A.4.3 `SetRolesForUser` flow (idempotent diff)

```
1. user = findById(id) || RbacUserNotFoundError
2. roleIds.length >= 1 → AtLeastOneRoleRequiredError
3. For each roleId: findById → RbacRoleNotFoundError (collect all errors? — NO: throw on first per existing convention)
4. current = listForUser(id) → string[]
5. toAdd = roleIds - current; toRemove = current - roleIds
6. If user CURRENTLY has super_admin AND 'super_admin' role is in toRemove:
     count = countUsersWithRoleCode('super_admin')
     if (count <= 1) → CannotRemoveLastSuperAdminError
7. For each roleId in toRemove: rbacUserRoleRepo.revoke(id, roleId)
8. For each roleId in toAdd:    rbacUserRoleRepo.assign(id, roleId)
9. return roleIds resolved as RbacRoleDto[]
```

**Concurrency note**: two admins editing the same user's roles simultaneously → last-write-wins. Accepted per proposal Risk #5. We do NOT add SQL-level locking — InMemory wouldn't honor it, and admin volume is low. Document as known limitation in spec.

### A.4.4 `RemoveRoleFromUser` flow

```
1. user = findById(userId) || RbacUserNotFoundError
2. role = findById(roleId) || RbacRoleNotFoundError
3. current = listForUser(userId)
4. If current.length === 1 AND current[0] === roleId → AtLeastOneRoleRequiredError
5. If role.code === 'super_admin':
     count = countUsersWithRoleCode('super_admin')
     if (count <= 1) → CannotRemoveLastSuperAdminError
6. rbacUserRoleRepo.revoke(userId, roleId)
```

---

## A.5. Router — `src/infrastructure/http/routes/rbacUser.routes.ts`

```ts
export function createRbacUserRouter(deps: {
  authMiddleware: RequestHandler;
  requirePermAdmin: RequestHandler;          // requirePerm('admin','manage')
  listRbacUsers: ListRbacUsers;
  getRbacUser: GetRbacUser;
  createRbacUser: CreateRbacUser;
  updateRbacUser: UpdateRbacUser;
  deleteRbacUser: DeleteRbacUser;
  changeRbacUserPassword: ChangeRbacUserPassword;
  listRolesForUser: ListRolesForUser;
  setRolesForUser: SetRolesForUser;
  assignRoleToUser: AssignRoleToUser;
  removeRoleFromUser: RemoveRoleFromUser;
}): Router {
  const router = Router();

  // Auth FIRST (populates req.user.id), THEN permission gate.
  router.use(deps.authMiddleware);
  router.use(deps.requirePermAdmin);

  router.get   ('/',                       handlerList);
  router.get   ('/:id',                    handlerGet);
  router.post  ('/',                       handlerCreate);
  router.patch ('/:id',                    handlerUpdate);
  router.delete('/:id',                    handlerDelete);          // reads req.user.id
  router.post  ('/:id/password',           handlerChangePassword);
  router.get   ('/:id/roles',              handlerListRoles);
  router.put   ('/:id/roles',              handlerSetRoles);        // bulk replace
  router.post  ('/:id/roles',              handlerAssignRole);
  router.delete('/:id/roles/:roleId',      handlerRemoveRole);      // reads req.user.id

  return router;
}
```

Handler bodies follow the codebase convention: try/catch domain errors → map to status codes per the error table (A.7). Always respond with `toRbacUserDto` or `toRbacRoleDto[]`. Never serialize the entity directly.

**`actingUserId`** for `DeleteRbacUser` and role-removal use cases: read from `req.user!.id`. The `requirePermission` middleware (SDD #1) only attaches if `req.user.id` exists, so non-null assertion is safe AFTER the middleware chain.

**Legacy `User.role` field is unused** by the new flow. The legacy JwtAuthAdapter still populates it from the legacy `Admin.role` column; we ignore it. RBAC roles are resolved through `RbacUserRoleRepository.listForUser(req.user.id)` inside `requirePermission`. This means the JWT user MUST also exist in `RbacUser` for the gate to find roles — covered by the bootstrap script (A.8).

---

## A.6. Authorization integration

- `req.user` is set by `createAuthMiddleware(authProvider)` in `auth.routes.ts` after a successful login cookie. Shape: `{ id, username, email, role }` (legacy).
- `requirePerm('admin','manage')` (already exported from `app.ts` as a named export per SDD #1 design) does:
  - resolve `req.user.id` → 401 if absent
  - short-circuit if any role has `code === 'super_admin'`
  - else check `listPermissionsForUser` for `module='admin' AND action='manage'`
- **Key gotcha**: `req.user.id` must match an `RbacUser.id`. The legacy `Admin` table uses different IDs. SDD #2 does NOT migrate legacy admins — that's SDD #6. The bootstrap script seeds a SINGLE super_admin RbacUser whose login matches the legacy admin login the user is going to log in with; the JWT issued by `auth.routes.ts` carries the legacy `Admin.id`, NOT the new `RbacUser.id`.

**This is a real bug we must address in design**: `requirePerm` calls `rbacUserRepo.listRolesForUser(req.user.id)` with the LEGACY admin id, finds zero roles, returns 403. The bootstrap RbacUser is unreachable.

**Resolution — two options:**

| Option | Pros | Cons |
|---|---|---|
| **A.** Patch `JwtAuthAdapter.login` to ALSO look up the matching `RbacUser` by login and put `rbacUserId` in the JWT payload + the `User` entity. `requirePerm` reads `req.user.rbacUserId`. | Minimal blast radius. Backwards compatible. | Touches the JWT shape (small additive). |
| **B.** Defer to SDD #6. Skip mounting `requirePerm` in SDD #2 — bake an interim guard that checks `req.user.role === 'super_admin'` (legacy field). | No JWT change. | Defeats the SDD #2 stated goal of "first production mount of requirePerm". |

**Chosen**: **Option A** (additive JWT). The change is:

1. In `JwtAuthAdapter.login`, after a successful legacy admin login, look up `rbacUserRepo.findByLogin(username)` and, if present, attach `rbacUserId` to the returned `User` entity AND include it in the JWT payload.
2. Extend the `User` entity (`src/domain/entities/auth.ts`) with `rbacUserId: string | null`.
3. Patch `requirePermission` to read `req.user.rbacUserId ?? req.user.id` — **graceful fallback**, so legacy users without a matching RbacUser still get the 403 path (not 500).
4. `bootstrapRbac.ts` seeds an `RbacUser` whose `login` MATCHES the legacy admin login so login → JWT → `req.user.rbacUserId` resolves correctly.

This adds ~15 LOC to `JwtAuthAdapter` and ~2 LOC to `requirePermission`. Tests for both updated.

**Open consideration**: spec author should flag this in the spec doc as a delta against SDD #1's "requirePerm reads req.user.id" assertion. The fallback (`?? req.user.id`) means tests written for SDD #1 keep passing.

---

## A.7. Error code mapping table

| Domain error | HTTP | Response body |
|---|---|---|
| `RbacUserNotFoundError` | 404 | `{ error: 'Not found', code: 'RBAC_USER_NOT_FOUND' }` |
| `RbacRoleNotFoundError` | 404 | `{ error: 'Not found', code: 'RBAC_ROLE_NOT_FOUND' }` |
| `LoginAlreadyTakenError` | 409 | `{ error: '...', code: 'LOGIN_ALREADY_TAKEN' }` |
| `EmailAlreadyTakenError` | 409 | `{ error: '...', code: 'EMAIL_ALREADY_TAKEN' }` |
| `AtLeastOneRoleRequiredError` | 400 | `{ error: '...', code: 'AT_LEAST_ONE_ROLE_REQUIRED' }` |
| `PasswordTooShortError` | 400 | `{ error: '...', code: 'PASSWORD_TOO_SHORT' }` |
| `CannotDeleteSelfError` | 403 | `{ error: '...', code: 'CANNOT_DELETE_SELF' }` |
| `CannotRemoveLastSuperAdminError` | 403 | `{ error: '...', code: 'CANNOT_REMOVE_LAST_SUPER_ADMIN' }` |
| Other (catch-all) | 500 | delegated to `errorHandler` middleware |
| Middleware 401 | 401 | per SDD #1 `NO_USER_CONTEXT` |
| Middleware 403 | 403 | per SDD #1 `PERMISSION_DENIED` |

---

## A.8. Bootstrap script — `src/scripts/bootstrapRbac.ts`

### A.8.1 Structure

```ts
/**
 * bootstrapRbac — idempotent first-super_admin seed.
 *
 * Reads BOOTSTRAP_RBAC_LOGIN / BOOTSTRAP_RBAC_EMAIL / BOOTSTRAP_RBAC_NAME /
 * BOOTSTRAP_RBAC_PASSWORD_HASH. The hash is PRE-COMPUTED with bcrypt cost 10
 * (decision #2 — no plaintext password in envs).
 *
 * Preconditions for the INSERT to fire:
 *   1. All 4 envs present and non-empty
 *   2. No RbacUser exists with that login
 *   3. No RbacUser exists with role super_admin (yes, even one different login)
 *
 * If any precondition fails: log skip reason, exit(0). Idempotent re-runs are
 * a no-op. Hash format mismatch is the operator's problem (we don't validate
 * the bcrypt format — bcrypt itself will fail when the user tries to log in
 * and that's a louder, actionable signal).
 */
async function main() {
  const cfg = {
    login: process.env.BOOTSTRAP_RBAC_LOGIN,
    email: process.env.BOOTSTRAP_RBAC_EMAIL,
    name:  process.env.BOOTSTRAP_RBAC_NAME,
    hash:  process.env.BOOTSTRAP_RBAC_PASSWORD_HASH,
  };
  if (!cfg.login || !cfg.email || !cfg.name || !cfg.hash) {
    console.log('[bootstrap-rbac] missing envs, skipping');
    process.exit(0);
  }

  const prisma = new PrismaClient({ adapter: ... });   // same wiring as src/infrastructure/database/prisma.ts
  try {
    const existingByLogin = await prisma.rbacUser.findUnique({ where: { login: cfg.login } });
    if (existingByLogin) { console.log('[bootstrap-rbac] login exists, skipping'); return; }

    const superAdminRole = await prisma.rbacRole.findUnique({ where: { code: 'super_admin' } });
    if (!superAdminRole) {
      console.error('[bootstrap-rbac] super_admin role missing — was the SDD #1 migration applied?');
      process.exit(1);
    }
    const anySuperAdmin = await prisma.rbacUserRole.findFirst({ where: { roleId: superAdminRole.id } });
    if (anySuperAdmin) { console.log('[bootstrap-rbac] a super_admin already exists, skipping'); return; }

    const user = await prisma.rbacUser.create({
      data: { name: cfg.name, email: cfg.email, login: cfg.login, passwordHash: cfg.hash, status: 'active' },
    });
    await prisma.rbacUserRole.create({ data: { userId: user.id, roleId: superAdminRole.id } });
    console.log(`[bootstrap-rbac] seeded super_admin user.id=${user.id}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error('[bootstrap-rbac] failed', e); process.exit(1); });
```

### A.8.2 `package.json` script

```json
{
  "scripts": {
    "rbac:bootstrap": "ts-node -r tsconfig-paths/register src/scripts/bootstrapRbac.ts"
  }
}
```

For production deploy we want a compiled artifact. Since the container already builds (`npm run build` → `dist/`), the deploy step uses `node dist/scripts/bootstrapRbac.js`. We add `src/scripts/bootstrapRbac.ts` to the `tsc` includes (it's already under `src/` so default `tsconfig.json` covers it — confirm during tasks).

### A.8.3 `.github/workflows/deploy.yml` — added step

Inserted AFTER `Run DB migrations` and BEFORE `Deploy container`:

```yaml
      - name: Bootstrap RBAC super_admin (idempotent)
        run: |
          docker run --rm \
            --network easypanel-bd_owners \
            -e DATABASE_URL="${{ secrets.DATABASE_URL }}" \
            -e BOOTSTRAP_RBAC_LOGIN="${{ secrets.BOOTSTRAP_RBAC_LOGIN }}" \
            -e BOOTSTRAP_RBAC_EMAIL="${{ secrets.BOOTSTRAP_RBAC_EMAIL }}" \
            -e BOOTSTRAP_RBAC_NAME="${{ secrets.BOOTSTRAP_RBAC_NAME }}" \
            -e BOOTSTRAP_RBAC_PASSWORD_HASH="${{ secrets.BOOTSTRAP_RBAC_PASSWORD_HASH }}" \
            ipnext-backend:latest \
            node dist/scripts/bootstrapRbac.js
```

If the operator has not yet set the 4 envs in EasyPanel, the script's "missing envs, skipping" branch keeps the deploy green. Operator workflow doc (separate, not in code):
- Generate hash locally: `node -e "console.log(require('bcryptjs').hashSync('miPassword', 10))"`
- Paste the hash + login + email + name as repo secrets
- Re-deploy; first run seeds the user; subsequent runs are no-op.

### A.8.4 Unit test

`src/__tests__/scripts/bootstrapRbac.test.ts` — extract the body into a `runBootstrap({ env, repoFactory })` function so we can call it with:
- a stub `env` map (all 4 keys / missing 1 / missing all)
- a factory returning `InMemoryRbacUserRepository` + `InMemoryRbacRoleRepository` + `InMemoryRbacUserRoleRepository` pre-seeded with the `super_admin` role

Assertions:
- missing envs → no-op, no user created
- happy path → user created, role assigned
- login already exists → skip, no error
- super_admin already exists with different login → skip, no error
- missing super_admin role → throws (operator-actionable)

---

## A.9. DI additions in `app.ts`

Diff (positions are approximate; the file is the 935-line god object):

Imports block (around the existing RBAC imports near line 355):

```ts
// NEW
import { BcryptPasswordHasher } from '../adapters/bcrypt/BcryptPasswordHasher';
import { ListRbacUsers }          from '@application/use-cases/rbac/ListRbacUsers';
import { GetRbacUser }            from '@application/use-cases/rbac/GetRbacUser';
import { CreateRbacUser }         from '@application/use-cases/rbac/CreateRbacUser';
import { UpdateRbacUser }         from '@application/use-cases/rbac/UpdateRbacUser';
import { DeleteRbacUser }         from '@application/use-cases/rbac/DeleteRbacUser';
import { ChangeRbacUserPassword } from '@application/use-cases/rbac/ChangeRbacUserPassword';
import { ListRolesForUser }       from '@application/use-cases/rbac/ListRolesForUser';
import { SetRolesForUser }        from '@application/use-cases/rbac/SetRolesForUser';
import { AssignRoleToUser }       from '@application/use-cases/rbac/AssignRoleToUser';
import { RemoveRoleFromUser }     from '@application/use-cases/rbac/RemoveRoleFromUser';
import { createRbacUserRouter }   from './routes/rbacUser.routes';
import { createAuthMiddleware }   from './middleware/authMiddleware';
```

Module-level (next to the existing 5 RBAC singletons around line 380):

```ts
const passwordHasher = new BcryptPasswordHasher();
```

Inside `createApp()`, with the rest of the use-case wiring (location: a new "// RBAC user management" block right after the existing partner/role/admin block around line 608):

```ts
  const listRbacUsers          = new ListRbacUsers(rbacUserRepo);
  const getRbacUser            = new GetRbacUser(rbacUserRepo);
  const createRbacUser         = new CreateRbacUser(rbacUserRepo, rbacRoleRepo, rbacUserRoleRepo, passwordHasher);
  const updateRbacUser         = new UpdateRbacUser(rbacUserRepo);
  const deleteRbacUser         = new DeleteRbacUser(rbacUserRepo);
  const changeRbacUserPassword = new ChangeRbacUserPassword(rbacUserRepo, passwordHasher);
  const listRolesForUser       = new ListRolesForUser(rbacUserRepo, rbacRoleRepo);
  const setRolesForUser        = new SetRolesForUser(rbacUserRepo, rbacRoleRepo, rbacUserRoleRepo);
  const assignRoleToUser       = new AssignRoleToUser(rbacUserRepo, rbacRoleRepo, rbacUserRoleRepo);
  const removeRoleFromUser     = new RemoveRoleFromUser(rbacUserRepo, rbacRoleRepo, rbacUserRoleRepo);
```

Mount, in the routes block:

```ts
  app.use('/api/admin/rbac/users', createRbacUserRouter({
    authMiddleware: createAuthMiddleware(authAdapter),
    requirePermAdmin: requirePerm('admin', 'manage'),
    listRbacUsers, getRbacUser, createRbacUser, updateRbacUser, deleteRbacUser,
    changeRbacUserPassword, listRolesForUser, setRolesForUser, assignRoleToUser, removeRoleFromUser,
  }));
```

Also a tiny read-only "list roles" surface for the FE selector — REUSES `roleRepo`? No — `roleRepo` is the LEGACY `Role` table. We add a thin GET endpoint that returns `rbacRoleRepo.listAll()`:

```ts
  // GET /api/admin/rbac/roles — read-only, used by the user modal role selector
  const rbacRolesRouter = Router();
  rbacRolesRouter.use(createAuthMiddleware(authAdapter));
  rbacRolesRouter.use(requirePerm('admin', 'manage')); // same gate
  rbacRolesRouter.get('/', async (_req, res) => {
    const roles = await rbacRoleRepo.listAll();
    res.json(roles.map(toRbacRoleDto));
  });
  app.use('/api/admin/rbac/roles', rbacRolesRouter);
```

Total lines added to `app.ts`: ~25. **Do not refactor** the god object — explicitly out of scope per project standards.

---

## A.10. Test strategy (BE)

| Layer | What | Tool | Where |
|---|---|---|---|
| Domain port (PasswordHasher) | Contract: hash≠plain, verify roundtrips, malformed verify=false | shared test file, both adapters | `src/__tests__/infrastructure/adapters/_shared/passwordHasherContractTests.ts` |
| RbacUserRepository extension | Update/delete/listAll/countUsersWithRoleCode contract | shared, both InMemory + Prisma (Prisma gated by DATABASE_URL_TEST) | extend SDD #1 `_shared/rbacUser*ContractTests.ts` |
| Use cases | 10 use cases × happy path + each thrown error | Jest with InMemory ports + `InMemoryPasswordHasher` | `src/__tests__/application/use-cases/rbac/*.test.ts` |
| Routes | supertest against full Express app with InMemory repos. Cover: 401 (no cookie), 403 (no admin perm), 200 (super_admin), 200 (perm-only admin), 409 dup, 404, 400 validation, security snapshot (`passwordHash` absent in JSON). | Jest + supertest | `src/__tests__/infrastructure/http/routes/rbacUser.routes.test.ts` |
| Bootstrap script | Idempotency matrix (envs present/missing × user exists/not × super_admin exists/not) | Jest + InMemory repos | `src/__tests__/scripts/bootstrapRbac.test.ts` |

**STRICT TDD MODE**: every file above starts as a failing test. No production code without a failing test pointing at it.

---

# PART B — FRONTEND DESIGN

## B.0. File layout

```
src/
├── api/
│   ├── rbacUsers.api.ts         # NEW
│   └── rbacRoles.api.ts         # NEW
├── hooks/
│   ├── useRbacUsers.ts          # NEW
│   └── useRbacRoles.ts          # NEW
├── types/
│   ├── rbacUser.ts              # NEW
│   └── rbacRole.ts              # NEW
├── constants/
│   └── rbacRoleLabels.ts        # NEW — system roles dict (decision #3, proposal Risk #3 option a)
├── pages/system/admin/
│   └── RbacUsersBody.tsx        # NEW — body + RbacUserModal in same file (catalog-page pattern)
└── pages/system/
    └── AdminPage.tsx            # MODIFIED — 'admins' tab content → <RbacUsersBody/>
```

We KEEP the single-file pattern (`SchedulingTaskCategoriesPage`) — `RbacUserModal` lives at the top of `RbacUsersBody.tsx`. If the modal grows past ~250 lines we extract; not now.

---

## B.1. Type definitions — `src/types/rbacUser.ts` + `rbacRole.ts`

```ts
// types/rbacRole.ts
export interface RbacRole {
  id: string;
  code: string;
  label: string;
  isSystem: boolean;
}

// types/rbacUser.ts
import type { RbacRole } from './rbacRole';

export type RbacUserStatus = 'active' | 'disabled';

export interface RbacUser {
  id: string;
  name: string;
  email: string;
  login: string;
  status: RbacUserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface RbacUserWithRoles extends RbacUser {
  roles: RbacRole[];
}

export interface CreateRbacUserInput {
  name: string;
  email: string;
  login: string;
  password: string;
  status?: RbacUserStatus;
  roleIds: string[];           // length >= 1
}

export interface UpdateRbacUserInput {
  name?: string;
  email?: string;
  status?: RbacUserStatus;
}

export interface ChangeRbacUserPasswordInput {
  password: string;
}

export interface SetRolesForUserInput {
  roleIds: string[];           // length >= 1
}
```

Note: `passwordHash` does NOT exist in any TS type. If the BE leaked it, the FE would still type-check (excess properties are silently dropped); the BE snapshot test is the real backstop.

---

## B.2. API files

### `src/api/rbacUsers.api.ts`

```ts
import axiosClient from './axios-client';
import type {
  RbacUser, RbacUserWithRoles,
  CreateRbacUserInput, UpdateRbacUserInput,
  ChangeRbacUserPasswordInput, SetRolesForUserInput,
} from '@/types/rbacUser';
import type { RbacRole } from '@/types/rbacRole';

const BASE = '/admin/rbac/users';

export const rbacUsersApi = {
  list:          (params?: { search?: string; status?: 'active' | 'disabled' }) =>
                   axiosClient.get<RbacUser[]>(BASE, { params }).then(r => r.data),
  get:           (id: string) =>
                   axiosClient.get<RbacUserWithRoles>(`${BASE}/${id}`).then(r => r.data),
  create:        (input: CreateRbacUserInput) =>
                   axiosClient.post<RbacUserWithRoles>(BASE, input).then(r => r.data),
  update:        (id: string, patch: UpdateRbacUserInput) =>
                   axiosClient.patch<RbacUser>(`${BASE}/${id}`, patch).then(r => r.data),
  delete:        (id: string) =>
                   axiosClient.delete<void>(`${BASE}/${id}`).then(() => undefined),
  changePassword:(id: string, body: ChangeRbacUserPasswordInput) =>
                   axiosClient.post<void>(`${BASE}/${id}/password`, body).then(() => undefined),
  listRoles:     (id: string) =>
                   axiosClient.get<RbacRole[]>(`${BASE}/${id}/roles`).then(r => r.data),
  setRoles:      (id: string, body: SetRolesForUserInput) =>
                   axiosClient.put<RbacRole[]>(`${BASE}/${id}/roles`, body).then(r => r.data),
};
```

### `src/api/rbacRoles.api.ts` (read-only)

```ts
import axiosClient from './axios-client';
import type { RbacRole } from '@/types/rbacRole';

export const rbacRolesApi = {
  list: () => axiosClient.get<RbacRole[]>('/admin/rbac/roles').then(r => r.data),
};
```

---

## B.3. Hooks — `useRbacUsers.ts` + `useRbacRoles.ts`

```ts
// hooks/useRbacRoles.ts
import { useQuery } from '@tanstack/react-query';
import { rbacRolesApi } from '@/api/rbacRoles.api';

export function useRbacRoles() {
  return useQuery({
    queryKey: ['rbac', 'roles'],
    queryFn: rbacRolesApi.list,
    staleTime: 60_000,
  });
}
```

```ts
// hooks/useRbacUsers.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rbacUsersApi } from '@/api/rbacUsers.api';

const LIST_KEY = ['rbac', 'users'] as const;
const detailKey = (id: string) => ['rbac', 'users', id] as const;

export function useRbacUsers(params?: { search?: string; status?: 'active' | 'disabled' }) {
  return useQuery({
    queryKey: [...LIST_KEY, params ?? {}],
    queryFn: () => rbacUsersApi.list(params),
    staleTime: 30_000,
  });
}

export function useRbacUser(id: string | null) {
  return useQuery({
    queryKey: detailKey(id ?? ''),
    queryFn: () => rbacUsersApi.get(id as string),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateRbacUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: rbacUsersApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: LIST_KEY }); },
  });
}

export function useUpdateRbacUser(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<typeof rbacUsersApi.update>[1]) => rbacUsersApi.update(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
      qc.invalidateQueries({ queryKey: detailKey(id) });
    },
  });
}

export function useDeleteRbacUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rbacUsersApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: LIST_KEY }); },
  });
}

export function useChangeRbacUserPassword(id: string) {
  return useMutation({
    mutationFn: (body: { password: string }) => rbacUsersApi.changePassword(id, body),
    // no invalidation needed — password isn't surfaced
  });
}

export function useSetUserRoles(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (roleIds: string[]) => rbacUsersApi.setRoles(id, { roleIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
      qc.invalidateQueries({ queryKey: detailKey(id) });
    },
  });
}
```

---

## B.4. System roles dict — `src/constants/rbacRoleLabels.ts`

Per decision (proposal Risk #3 option **a**): hardcode FE dict NOW; defer to BE label resolution in SDD #3 if/when custom roles need richer display.

```ts
import type { RbacRole } from '@/types/rbacRole';

export interface SystemRoleMeta {
  label: string;   // Spanish display label
  badgeColor: string; // CSS token name (mapped in module.css)
}

/**
 * Hardcoded display metadata for the 6 system roles.
 * BE returns code + (label, isSystem); FE prefers this dict for system roles
 * and falls back to RbacRole.label for custom roles (SDD #3+).
 */
export const SYSTEM_ROLE_META: Record<string, SystemRoleMeta> = {
  super_admin:    { label: 'Super Administrador', badgeColor: 'role-super-admin' },     // rojo destacado
  administrador:  { label: 'Administrador',       badgeColor: 'role-administrador' },   // azul oscuro
  administracion: { label: 'Administración',      badgeColor: 'role-administracion' },  // verde
  ventas:         { label: 'Ventas',              badgeColor: 'role-ventas' },          // naranja
  noc:            { label: 'NOC',                 badgeColor: 'role-noc' },             // violeta
  tecnico:        { label: 'Técnico',             badgeColor: 'role-tecnico' },         // azul claro
};

export function roleDisplay(role: Pick<RbacRole, 'code' | 'label' | 'isSystem'>): SystemRoleMeta {
  return SYSTEM_ROLE_META[role.code] ?? { label: role.label, badgeColor: 'role-custom' };
}
```

The `module.css` for the body declares the badge colors via `--color-*` tokens:

```css
.badge-role-super-admin     { background: var(--color-danger-soft);   color: var(--color-danger-strong); }
.badge-role-administrador   { background: var(--color-info-soft);     color: var(--color-info-strong); }
.badge-role-administracion  { background: var(--color-success-soft);  color: var(--color-success-strong); }
.badge-role-ventas          { background: var(--color-warning-soft);  color: var(--color-warning-strong); }
.badge-role-noc             { background: var(--color-violet-soft);   color: var(--color-violet-strong); }
.badge-role-tecnico         { background: var(--color-sky-soft);      color: var(--color-sky-strong); }
.badge-role-custom          { background: var(--color-neutral-soft);  color: var(--color-neutral-strong); }
```

Token names may need to be aligned with `src/tokens/variables.css` during apply — fallback is to use `--color-primary-*` etc. that already exist.

---

## B.5. `RbacUsersBody` component design

### State

- TanStack Query: `useRbacUsers({ search, status })`, `useDeleteRbacUser()`
- Local: `search: string`, `statusFilter: 'all' | 'active' | 'disabled'`, `showCreate: boolean`, `editing: RbacUser | null`

### Layout (top → bottom)

```
┌─ Header ──────────────────────────────────────────────┐
│ <PageHeader title="Usuarios" />                       │  <- title styled per FE convention
│   subtitle: "Gestión de cuentas con acceso al panel"  │
│                                          [+ Nuevo]    │
└───────────────────────────────────────────────────────┘
┌─ Filter row ──────────────────────────────────────────┐
│ [Search input — debounce 300ms]  [Status: all/active/disabled] │
└───────────────────────────────────────────────────────┘
┌─ Table card ──────────────────────────────────────────┐
│  Loading (skeleton 3 rows) | Empty state | DataTable  │
│  Columns: Nombre | Login | Email | Estado | Roles | Última conexión | Acciones │
└───────────────────────────────────────────────────────┘
└─ Modal (mounted when showCreate || editing) ─────────┐
   <RbacUserModal initial={editing} onClose=... onSaved=... />
```

### Table column details

- **Roles**: render badges using `SYSTEM_ROLE_META[role.code]?.label ?? role.label`, color per badgeColor. Max 3 visible; "+N" overflow chip.
- **Última conexión**: `formatRelative(lastLoginAt)` — "Nunca" if null.
- **Acciones**: `[Editar]` `[Borrar]`. Edit opens modal with `initial=user`. Delete fires `window.confirm(...)` then `useDeleteRbacUser().mutateAsync(id)` — see AD-FE-9.

### Empty state (decision)

When `data.length === 0` AND no filters active:

```
┌─ Card ────────────────────────────────────────────────┐
│  [icon-users-empty]                                   │
│  No hay usuarios todavía                              │
│                                                       │
│  Si recién deployaste, asegurate de configurar        │
│  BOOTSTRAP_RBAC_LOGIN, _EMAIL, _NAME y                │
│  _PASSWORD_HASH en el servidor. El próximo deploy     │
│  va a sembrar tu primer super_admin.                  │
│                                                       │
│  Más info: docs/rbac-bootstrap.md (interno)           │
└───────────────────────────────────────────────────────┘
```

When filters are active and 0 results: shorter "Sin resultados para esos filtros".

---

## B.6. `RbacUserModal` component design

### Props

```ts
interface RbacUserModalProps {
  initial: RbacUserWithRoles | null;   // null = create mode, non-null = edit
  onClose: () => void;
  onSaved: () => void;                 // parent refetches via invalidations
}
```

### Form structure (react-hook-form)

```ts
interface FormValues {
  name: string;
  email: string;
  login: string;
  password: string;
  passwordConfirm: string;
  status: 'active' | 'disabled';
  roleIds: string[];
  // Edit-only:
  changePassword: boolean;           // collapses password fields by default
}
```

### Layout

```
┌─ Sticky header ──────────────────────────────────────┐
│ {mode === 'create' ? 'Nuevo usuario' : 'Editar usuario'} │
│                                                  [×] │
└──────────────────────────────────────────────────────┘
┌─ Body (scrollable) ──────────────────────────────────┐
│ [Nombre]            [Login]    (login disabled in edit) │
│ [Email]             [Estado: active | disabled]      │
│                                                       │
│ [Password section]                                    │
│   create:  [Contraseña] [Confirmar contraseña]       │
│   edit:    [☐ Cambiar contraseña]                    │
│             ↳ if checked: [Contraseña] [Confirmar]   │
│                                                       │
│ [Roles section]                                       │
│   <RoleMultiSelect value={roleIds} onChange=...>    │
│   (See B.7 — chips + autocomplete)                  │
│                                                       │
│ [General error banner — top-of-form for 4xx]         │
└──────────────────────────────────────────────────────┘
┌─ Footer ─────────────────────────────────────────────┐
│                              [Cancelar] [Guardar]    │
└──────────────────────────────────────────────────────┘
```

### Validation rules (mirror BE)

| Field | Client rule | BE error mapping |
|---|---|---|
| `name`     | required, trim ≥ 1 char | — |
| `email`    | required, basic email regex `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` | `EMAIL_ALREADY_TAKEN` → "Ese email ya está en uso" |
| `login`    | required, ≥ 3 chars, `^[a-zA-Z0-9_.-]+$`, immutable in edit | `LOGIN_ALREADY_TAKEN` → "Ese login ya está en uso" |
| `password` (create OR `changePassword=true`) | ≥ 8 chars | `PASSWORD_TOO_SHORT` → "Contraseña: mínimo 8 caracteres" |
| `passwordConfirm` | === `password` | client-only |
| `roleIds`  | length ≥ 1 | `AT_LEAST_ONE_ROLE_REQUIRED` → "Asigná al menos un rol" |
| `status`   | enum | — |

Inline errors render via `<FieldError aria-describedby={`${name}-error`} />`. Submit button disabled while `formState.isSubmitting || !formState.isValid`.

### Submit handler

```ts
async function onSubmit(values: FormValues) {
  try {
    if (initial) {
      // Edit
      await updateMutation.mutateAsync({ name, email, status });
      if (values.changePassword) {
        await changePasswordMutation.mutateAsync({ password: values.password });
      }
      // roleIds compared to initial.roles; only fire if changed
      const initialIds = initial.roles.map(r => r.id).sort();
      const newIds = [...values.roleIds].sort();
      if (JSON.stringify(initialIds) !== JSON.stringify(newIds)) {
        await setRolesMutation.mutateAsync(values.roleIds);
      }
    } else {
      // Create
      await createMutation.mutateAsync({
        name, email, login, password, status, roleIds,
      });
    }
    onSaved();
    onClose();
  } catch (e) {
    setServerError(mapServerError(e));   // axios error → user msg by code
  }
}
```

`mapServerError` table:

| BE `code` | Field-level highlight | Banner text |
|---|---|---|
| `LOGIN_ALREADY_TAKEN`        | login field red | "Ese login ya está en uso" |
| `EMAIL_ALREADY_TAKEN`        | email field red | "Ese email ya está en uso" |
| `PASSWORD_TOO_SHORT`         | password field red | "Contraseña: mínimo 8 caracteres" |
| `AT_LEAST_ONE_ROLE_REQUIRED` | roles section red | "Tenés que asignar al menos un rol" |
| `CANNOT_DELETE_SELF`         | — (delete flow) | "No podés borrar tu propio usuario" |
| `CANNOT_REMOVE_LAST_SUPER_ADMIN` | roles section red | "Quedaría el sistema sin Super Administradores — asigná otro primero" |
| `RBAC_USER_NOT_FOUND`        | — | "Ese usuario ya no existe (refrescá la lista)" |
| `RBAC_ROLE_NOT_FOUND`        | roles section red | "Uno de los roles seleccionados no existe (refrescá la lista)" |
| default                      | — | "Algo salió mal. Probá de nuevo." |

---

## B.7. Role multi-select sub-component

**Decision (AD-FE-3)**: keep it INLINE in `RbacUsersBody.tsx` first (local component above `RbacUserModal`). If a second screen needs it (SDD #3), extract to `src/components/molecules/RoleMultiSelect/`. Avoid speculative atomization.

### UX

```
[ Roles                                                ]
[ ┌────────────────────────────────────────────────┐ ]
[ │ [Super Administrador ×] [Ventas ×]             │ ]   <- selected chips
[ │ ┌──────────────────────────────────────────┐   │ ]
[ │ │ Buscar rol...                            │   │ ]   <- text input
[ │ └──────────────────────────────────────────┘   │ ]
[ └────────────────────────────────────────────────┘ ]
   ┌──────────────────────────────────────────────┐
   │ Roles del sistema                             │   <- popover, opens on focus
   │   ▢ Super Administrador  super_admin          │
   │   ▢ Administrador        administrador        │
   │   ▢ Administración       administracion       │
   │   ▢ Ventas               ventas (✓)           │
   │   ▢ NOC                  noc                  │
   │   ▢ Técnico              tecnico              │
   │ Roles personalizados                          │
   │   (vacío)                                     │
   └──────────────────────────────────────────────┘
```

- Chips: clicking the `×` removes; Backspace on empty input removes the last chip.
- Popover: opens on input focus, closes on outside click / Esc. Filters by substring match on label+code, case-insensitive.
- Keyboard: ↑/↓ navigate options, Enter toggles, Esc closes.
- Grouping: "Roles del sistema" first (the 6), "Roles personalizados" second (BE `isSystem === false`).
- Each option shows: label (system label via dict, else BE label) + faded code monospace.
- ARIA: input has `role="combobox" aria-expanded aria-controls`, popover `role="listbox"`, options `role="option" aria-selected`.
- Empty selection state: input placeholder "Seleccioná uno o más roles".

---

## B.8. `AdminPage.tsx` modification — exact diff

The current `'admins'` tab renders `<AdminsBody />` (legacy). We replace `content` only — id and label stay aware of decision #1.

```diff
- import { AdminsBody } from './admin/AdminsBody';
+ import { RbacUsersBody } from './admin/RbacUsersBody';

  const tabs = [
    // ...
    {
      id: 'admins',
-     label: 'Administradores',
+     label: 'Usuarios',
-     content: <AdminsBody />,
+     content: <RbacUsersBody />,
    },
    // ...
  ];
```

The legacy `AdminsBody`, `useAdmins`, and `admin.api.ts` files stay untouched (deleted in SDD #6).

If the existing tab definition does not have those exact shapes (label/content keys may differ), the apply phase adjusts to whatever the file uses — the principle is: same tab id, new label "Usuarios", new content `<RbacUsersBody />`.

---

## B.9. FE test strategy

Per the established convention (engram #141 + `SchedulingTaskCategoriesPage.test.tsx`):

| File | Mocks | Scenarios |
|---|---|---|
| `RbacUsersBody.test.tsx` | `vi.mock('@/hooks/useRbacUsers')`, `vi.mock('@/hooks/useRbacRoles')` | loading skeleton, empty state copy, table rows render roles with correct labels, "Nuevo" opens modal, edit row opens modal preloaded, delete fires confirm + mutation, delete error shows alert, status filter changes hook call, search debounce |
| `RbacUserModal.test.tsx` (covered inside `RbacUsersBody.test.tsx` since same file — but separately scoped `describe`) | hooks mocked | create happy path, create with 0 roles → submit disabled, password mismatch → submit disabled, edit mode: login disabled, changePassword toggle reveals fields, edit save calls update + setRoles only if roleIds changed, edit save with changePassword=true calls all three mutations, 409 LOGIN_ALREADY_TAKEN highlights field + banner, 409 EMAIL_ALREADY_TAKEN ditto, 400 AT_LEAST_ONE_ROLE_REQUIRED banner, 403 CANNOT_REMOVE_LAST_SUPER_ADMIN banner, Esc closes, click-outside closes (confirms first if dirty), focus trap on first field |
| `useRbacUsers.test.ts` | `vi.mock('@/api/rbacUsers.api')` | each hook fires the corresponding api method, mutations invalidate the right keys (assert via QueryClient spy) |
| `useRbacRoles.test.ts` | `vi.mock('@/api/rbacRoles.api')` | calls list, returns data |

`renderBody()` helper wraps in MemoryRouter (no QueryClientProvider since hooks are mocked at module level). `idleMutation = { mutateAsync: vi.fn(), isPending: false } as any` pattern.

---

## B.10. IMPECCABLE-driven named decisions

### AD-FE-1 — Visual hierarchy: table is the surface, modal is overlay

The page is a TABLE-centric admin workflow. The page header is small (caption + title), the filter bar is single-line, and the table dominates 70% of the viewport. The modal overlays at z-index above the page and dims the backdrop (var(--color-overlay-50)). Rationale: admins scan rows; everything else is secondary chrome.

### AD-FE-2 — Form library: react-hook-form + zod IF available, else plain RHF + manual validators

We use `react-hook-form` (confirmed available per engram #141). zod is NOT confirmed; design avoids depending on it. If `zod` shows up in `package.json`, the apply phase wires it through `@hookform/resolvers/zod` for compactness; otherwise we use RHF's `register({ validate: ... })`. **Tasks file MUST include a "verify zod presence" step** before locking the form pattern.

### AD-FE-3 — Role multi-select stays inline first, extracts on second consumer

Per project standard (Atomic design strict but tactical). Inline now, promote to molecule when SDD #3 (roles-permissions-management) reuses it. Avoid speculative molecule churn.

### AD-FE-4 — Empty state is a "did you forget to bootstrap?" hint card

Not a generic "No data" banner. The card spells out the env-var workflow because the realistic empty state on day one is "deploy ran, no super_admin yet". Reduces support tickets.

### AD-FE-5 — Skeleton loading, not a spinner

3 placeholder rows matching the column widths. Aligns with FE convention; spinner is reserved for inline mutation feedback inside the modal save button.

### AD-FE-6 — Modal: sticky header, Esc to close, click-outside with dirty confirm

Per FE convention (engram #141 catalog pattern). Dirty confirm uses native `window.confirm("Hay cambios sin guardar. ¿Cerrar?")` — same as `SchedulingTaskCategoriesPage`. Focus trap implemented via existing portal infrastructure or a tiny hand-rolled trap (~20 lines). Autofocus first text field on mount.

### AD-FE-7 — Error feedback: dual-layer (field highlight + banner)

Inline errors next to fields cover client-side validation. Server errors hit a top-of-modal banner AND highlight the relevant field where applicable (LOGIN, EMAIL, PASSWORD, ROLES). 403 errors that aren't field-specific (last super_admin) only show the banner.

### AD-FE-8 — Accessibility: labels + aria-describedby + role="dialog"

Every form field has `<label htmlFor>`. Errors connect via `aria-describedby={"${fieldName}-error"}`. Modal root is `role="dialog" aria-modal="true" aria-labelledby={titleId}`. Focus trap when open; restore focus to trigger button on close.

### AD-FE-9 — Confirm delete: native `confirm` with contextual message

```
Vas a borrar a {name} ({login}). Esta acción no se puede deshacer.
```

We DON'T build a custom confirm modal in SDD #2 — native `window.confirm` matches the established catalog pattern. SDD #6 can introduce a system-wide confirm dialog if needed.

### AD-FE-10 — Role badge color per system role, neutral gray for custom

Documented in B.4. Reuses existing semantic tokens (danger/info/success/warning/violet/sky/neutral) — no bespoke palette. If the token names differ at apply time, fall back to defining them locally in the module.css (worst case ~10 extra LOC).

### AD-FE-11 — Password section collapsed by default in edit mode

The "changePassword" checkbox keeps the form cognitively lighter for the common "edit name/email/roles" path.

**Two supported paths for password change (both work in production)**:

| Path | Endpoint | When used |
|------|----------|-----------|
| **Primary — admin-managed edit** | `PATCH /:id` with optional `password` field in `UpdateRbacUserDto` | FE uses this path when an admin edits a user and ticks "Cambiar contraseña". One round-trip saves all changes including the new password. |
| **Dedicated — password-only** | `POST /:id/password` | Kept for "Change password only" flows (e.g. future self-change, password expiry prompts). Also supports the `isAdminManaged` flag distinction for old-password verification. SDD #5 / SDD #6 may route self-change through this endpoint. |

**Current FE behavior**: the modal submit handler uses `PATCH /:id` when `changePassword = true` — it sends `{ name, email, status, password }` in a single request. The `POST /:id/password` endpoint exists and is wired but is NOT called by the current FE. Both endpoints are spec-compliant and tested. This is intentional: PATCH is the simpler path for admin-driven edits; POST /password is reserved for flows that need the old-password check or a standalone password-change UX.

### AD-FE-12 — Login field is immutable in edit

Display the login as `disabled` in edit mode with a small "?" tooltip: "El login es permanente — para reemplazarlo, creá un usuario nuevo". This sidesteps the cascade of audit/login-history concerns SDD #4 introduces.

Total impeccable decisions: **12**.

---

# PART C — CROSS-CUTTING

## C.1. Migration / schema

**NONE in this SDD.** All schema delivered in SDD #1. Bootstrap is a runtime script, not a migration. Confirmed approach (decision #2 + design A.8).

## C.2. Risks (delta over proposal)

| # | Risk | Mitigation |
|---|---|---|
| BE-1 | JWT `req.user.id` is the legacy `Admin.id`, not the `RbacUser.id`. `requirePerm` would always 403. | A.6 — patch `JwtAuthAdapter` to attach `rbacUserId` via `findByLogin(username)`; middleware reads `rbacUserId ?? id`. Tests cover both paths. |
| BE-2 | `RbacUserRepository` lacks `update/delete/listAll/count`. | A.2 — additive port extension with parallel updates to InMemory + Prisma adapters. Contract tests extended. |
| BE-3 | `delete()` cascade behavior. | A.2.2 — confirm SDD #1 migration's `ON DELETE CASCADE` on `RbacUserRole.userId`. If absent, wrap in `$transaction`. |
| BE-4 | Bootstrap script dist path. | A.8.2 — verify `src/scripts/` is included in `tsconfig` `include`; if not, add it during tasks. Fallback: `npx ts-node ...` in the deploy step. |
| FE-1 | zod presence uncertain. | AD-FE-2 — pure RHF validators as the default; zod resolver as optional shorthand. |
| FE-2 | Badge color tokens may not exist. | AD-FE-10 — fallback to module-local CSS variables. |
| FE-3 | `AdminPage.tsx` exact tab definition shape unknown to design. | B.8 — apply phase adapts; principle locked (id stays, label → "Usuarios", content → `<RbacUsersBody/>`). |

## C.3. Things explicitly OUT of scope (re-affirmed from proposal)

- Per-user permission overrides → future SDD
- Audit log mutations → SDD #4
- Session listing → SDD #5
- Password policy (complexity, history, expiry) → SDD #6
- 2FA → SDD #6
- Legacy `/admin/admins` retirement → SDD #6
- Pagination on user list → YAGNI now

---

## C.4. Test-seam summary (TDD checklist)

| Seam | Test type | First failing test |
|---|---|---|
| `PasswordHasher` contract | shared adapter tests | `hash(x) !== x` |
| `RbacUserRepository.update` | shared adapter tests | updates name field, persists |
| `RbacUserRepository.delete` | shared adapter tests | findById returns null after delete |
| `RbacUserRepository.listAll` | shared adapter tests | search filter case-insensitive name match |
| `RbacUserRepository.countUsersWithRoleCode` | shared adapter tests | seed 2 super_admins → count = 2 |
| 10 use cases | application tests | each happy path + each error |
| 11 route handlers | supertest tests | 401 unauth, 403 no perm, 200 super_admin path, 200 admin:manage path, every error code mapping |
| Bootstrap script | script test | missing envs → no-op |
| FE hooks | vitest hook tests | each hook calls the right api method |
| FE components | vitest + RTL | each AD-FE decision has at least one test |

---

**END OF DESIGN**
