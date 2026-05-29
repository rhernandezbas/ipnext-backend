# Spec — rbac-bootstrap (SDD #2 · BE Capability 4)

**Change**: user-management-crud
**Layer**: Infrastructure — bootstrap script
**File**: `src/infrastructure/bootstrap/bootstrapRbac.ts`

---

## Overview

Chicken-and-egg problem: the CRUD routes require `admin:manage` permission, but there are zero
`RbacUser` records in prod. The bootstrap script creates the first `super_admin` user from
environment variables. It is **idempotent** — safe to run on every deploy.

**Why NOT a Prisma migration**: PostgreSQL migrations cannot safely read Node.js environment
variables. SQL `DO $$ ... $$` blocks see the Postgres session context, not the shell env.
Interpolating envs into SQL strings at migration time is fragile and risks leaking credentials
into migration history files. The chosen approach (Option C) runs a standalone Node script
AFTER `prisma migrate deploy`, reads envs in Node, and upserts via the Prisma client with
`ON CONFLICT DO NOTHING` semantics.

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `BOOTSTRAP_RBAC_LOGIN` | Login (username) for the bootstrap super_admin |
| `BOOTSTRAP_RBAC_EMAIL` | Email for the bootstrap super_admin |
| `BOOTSTRAP_RBAC_NAME` | Display name for the bootstrap super_admin |
| `BOOTSTRAP_RBAC_PASSWORD_HASH` | **Pre-computed bcrypt hash** (cost 10). Never a plain-text password in env. |

**Generating the hash** (run locally, paste result into EasyPanel env):
```sh
node -e "console.log(require('bcryptjs').hashSync('mySecurePassword', 10))"
```

---

## Script location

```
src/infrastructure/bootstrap/bootstrapRbac.ts
```

The function is exported for testability:
```ts
export async function bootstrapRbac(
  userRepo: RbacUserRepository,
  roleRepo: RbacRoleRepository,
  userRoleRepo: RbacUserRoleRepository,
  env: BootstrapEnv
): Promise<BootstrapResult>

export interface BootstrapEnv {
  login: string | undefined;
  email: string | undefined;
  name: string | undefined;
  passwordHash: string | undefined;
}

export type BootstrapResult =
  | { outcome: 'skipped'; reason: 'envs-missing' | 'user-already-exists' | 'super_admin-already-assigned' }
  | { outcome: 'created'; login: string }
```

A thin `main()` function at the bottom reads `process.env` and calls the exported function, then
logs the result and exits. The entry point is NOT `bootstrapRbac.ts` itself — it is exposed via
`npm run bootstrap-rbac` which calls `ts-node -r tsconfig-paths/register src/infrastructure/bootstrap/bootstrapRbac.ts`.

---

## Algorithm

```
1. IF any of [login, email, name, passwordHash] is undefined or empty string:
     log "skipped: envs missing" → return { outcome: 'skipped', reason: 'envs-missing' }

2. IF a user with login === env.login already exists (userRepo.findByLogin):
     log "skipped: user already exists (login: <login>)" → return { outcome: 'skipped', reason: 'user-already-exists' }

3. IF any user is already assigned to the super_admin role:
     → query: list all users with super_admin assignment
     → if count > 0: log "skipped: super_admin already assigned" → return { outcome: 'skipped', reason: 'super_admin-already-assigned' }

4. Find the super_admin role: roleRepo.findByCode('super_admin')
   (role MUST exist — seeded in SDD #1 migration. If not found, throw Error('super_admin role not found in DB — run prisma migrate deploy first'))

5. Create user: userRepo.create({ name, email, login, passwordHash, status: 'active' })

6. Assign super_admin: userRoleRepo.assign(user.id, superAdminRole.id)

7. log "created: super_admin <login>" → return { outcome: 'created', login }
```

**Idempotency**: Steps 2 and 3 are the idempotency guards. Running the script twice on a system
that already has a super_admin user will exit at step 2 or step 3 with `skipped`.

---

## Logging contract

All output to `console.log` (not `console.error`). Format:

```
[bootstrap-rbac] skipped: envs missing
[bootstrap-rbac] skipped: user already exists (login: admin)
[bootstrap-rbac] skipped: super_admin already assigned
[bootstrap-rbac] created: super_admin admin
[bootstrap-rbac] ERROR: super_admin role not found in DB — run prisma migrate deploy first
```

---

## Requirements

- R-BOOT-1 When any env var is missing → outcome is `skipped / envs-missing`, NO write to DB.
- R-BOOT-2 When login already exists in DB → outcome is `skipped / user-already-exists`, NO write to DB.
- R-BOOT-3 When at least one user already has super_admin role → outcome is `skipped / super_admin-already-assigned`, NO write to DB.
- R-BOOT-4 When all 4 envs present, no existing login, and no existing super_admin → user is created and super_admin is assigned, outcome is `created`.
- R-BOOT-5 The stored value for `passwordHash` equals `env.passwordHash` verbatim (NOT re-hashed — env already contains a hash).
- R-BOOT-6 Function is pure (no `process.env` reads inside) — env values injected as parameter for testability.
- R-BOOT-7 `main()` wrapper reads `process.env`, calls `bootstrapRbac`, logs result, exits 0 on success.
- R-BOOT-8 If `super_admin` role not found in DB (SDD #1 migration not run), throws an `Error` with a clear message.

---

## Scenarios

WHEN all 4 env vars are set, no user with that login exists, no super_admin user exists  
THEN user is created with the given passwordHash (verbatim, NOT re-hashed)  
AND super_admin role is assigned to the new user  
AND result is `{ outcome: 'created', login: env.login }`

WHEN `BOOTSTRAP_RBAC_PASSWORD_HASH` is undefined  
THEN no DB writes  
AND result is `{ outcome: 'skipped', reason: 'envs-missing' }`

WHEN a user with `login === env.login` already exists  
THEN no DB writes  
AND result is `{ outcome: 'skipped', reason: 'user-already-exists' }`

WHEN another user already has super_admin role assigned  
THEN no DB writes  
AND result is `{ outcome: 'skipped', reason: 'super_admin-already-assigned' }`

WHEN `super_admin` role does not exist in roleRepo  
THEN throws `Error` with message containing `'super_admin role not found'`

---

## npm script

Add to `package.json`:
```json
"bootstrap-rbac": "ts-node -r tsconfig-paths/register src/infrastructure/bootstrap/bootstrapRbac.ts"
```

---

## Deploy step

Add to `.github/workflows/deploy.yml` AFTER the `Run DB migrations` step:

```yaml
- name: Bootstrap RBAC super_admin
  run: npm run bootstrap-rbac
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
    BOOTSTRAP_RBAC_LOGIN: ${{ secrets.BOOTSTRAP_RBAC_LOGIN }}
    BOOTSTRAP_RBAC_EMAIL: ${{ secrets.BOOTSTRAP_RBAC_EMAIL }}
    BOOTSTRAP_RBAC_NAME: ${{ secrets.BOOTSTRAP_RBAC_NAME }}
    BOOTSTRAP_RBAC_PASSWORD_HASH: ${{ secrets.BOOTSTRAP_RBAC_PASSWORD_HASH }}
```

The step is safe to run on EVERY deploy — idempotency guards prevent duplicate users.
If the env secrets are not set (e.g. staging environment), the script exits with `skipped: envs-missing` and the deploy continues normally.

---

## Test matrix

| Suite | File | Adapters |
|-------|------|---------|
| Unit — 3 main paths | `src/__tests__/infrastructure/bootstrap/bootstrapRbac.test.ts` | InMemory |

**Three required test cases**:
1. Missing envs → `skipped / envs-missing`
2. Login already exists → `skipped / user-already-exists`
3. No existing super_admin + all envs → `created`, user in repo with correct passwordHash

A 4th optional test: one user already has super_admin → `skipped / super_admin-already-assigned`.
