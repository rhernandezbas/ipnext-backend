# Design: Auth & RBAC Foundation

## Technical Approach

Add a parallel RBAC subsystem (`RbacUser`, `RbacRole`, `RbacPermission`, `RbacModule`, plus pivots `RbacUserRole`, `RbacRolePermission`) alongside the legacy `Admin` table. Ship 5 hexagonal ports + Prisma/InMemory adapters and an Express middleware `requirePermission(module, action)`. The legacy `Admin` flow stays untouched. Coexistence is explicit; data migration belongs to a future SDD. See `specs/auth-rbac/spec.md` for the requirements this design satisfies.

Naming uses the `Rbac*` prefix on every new entity to avoid colliding with the existing `User` (used by `auth.ts`), `Role` (`PrismaRoleRepository.ts` already exists), and `Permission` identifiers. Prefix is permanent — renaming after the legacy migration is a separate SDD's call.

## Architecture Decisions

### Decision: `RbacAction` as Prisma enum, not table

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Enum `RbacAction { read, write, delete, manage }` | Type-safe, no FK joins, schema is the source of truth | CHOSEN |
| `RbacAction` table with FK from `RbacPermission` | Dynamic, but actions are locked by decision #2 (orthogonal `manage`) and middleware switches on literal strings | rejected |

Rationale: actions are a closed set hard-coded into middleware signatures (`requirePermission('clients','read')`). A table adds joins for zero flexibility.

### Decision: `RbacPermission` as denormalized `(moduleId, action)` rows

| Option | Tradeoff | Decision |
|--------|----------|----------|
| One row per `(module, action)` pair; unique constraint | Simple seed, simple `listPermissionsForUser`, easy to reason about | CHOSEN |
| `RbacRole` holds `(moduleId, action)` directly without intermediate table | Fewer tables, but loses the ability to name/comment a permission and pre-validate matrix in seed | rejected |

Catalog size: 14 modules × 4 actions = 56 permission rows. Trivial.

### Decision: FK delete behavior — `RESTRICT` on catalog FKs, `CASCADE` on pivots

| FK | Behavior | Why |
|----|----------|-----|
| `RbacPermission.moduleId → RbacModule` | RESTRICT | Catalog rows must never disappear silently |
| `RbacRolePermission.{roleId,permissionId}` | CASCADE | Deleting a role or permission cleanly drops grants |
| `RbacUserRole.{userId,roleId}` | CASCADE | Deleting a user/role removes assignments |
| `RbacRole.isSystem = true` rows | DB allows delete; **CRUD layer in SDD #3 blocks it** | DB cannot express "soft system flag" cleanly |

### Decision: `super_admin` short-circuit in middleware, not DB

Middleware checks `user.roles.some(r => r.code === 'super_admin')` BEFORE the permission lookup. Avoids materializing 56 grant rows for super_admin and keeps the seed compact (still seeded as having `manage` on all 14 modules for audit reporting, but middleware never reads them).

### Decision: Single migration (DDL + seed) using `prisma migrate diff --script`

Per project convention seeds for catalogs live in the migration, not `seed.ts`. Single file simplifies rollback (one `DROP CASCADE` set). Generated via:

```bash
prisma migrate diff \
  --from-schema-datamodel /tmp/before.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20260529000000_auth_rbac_foundation/migration.sql
```

Append idempotent `INSERT … ON CONFLICT (code) DO NOTHING` for modules/permissions/roles, then `INSERT … ON CONFLICT (roleId, permissionId) DO NOTHING` for the matrix.

Timestamp `20260529000000` is later than the last existing migration (`20260528000000_iclass_so_type_catalog`).

## Data Flow

```
HTTP request
   │
   ▼
auth middleware (JWT)  ──→ req.user = { id, username, email, role }
   │
   ▼
requirePermission('clients','read')
   │
   ▼
RbacUserRepository.findById(req.user.id)
   │
   ▼ (single Prisma call with nested include)
user.roles → RolePermission → Permission(moduleId,action) → Module.code
   │
   ├── super_admin? → next()
   ├── matches (module,action)? → next()
   └── otherwise → 403 { error:'FORBIDDEN', code:'PERMISSION_DENIED', module, action }
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modify | Add 6 models + `RbacAction` enum |
| `prisma/migrations/20260529000000_auth_rbac_foundation/migration.sql` | Create | DDL + idempotent catalog & matrix seed |
| `src/domain/entities/rbac.ts` | Create | `RbacUser`, `RbacRole`, `RbacPermission`, `RbacModule`, `PermissionAction` union, module/role code constants |
| `src/domain/ports/RbacUserRepository.ts` | Create | Port |
| `src/domain/ports/RbacRoleRepository.ts` | Create | Port |
| `src/domain/ports/RbacPermissionRepository.ts` | Create | Port |
| `src/domain/ports/RbacUserRoleRepository.ts` | Create | Port |
| `src/domain/ports/RbacRolePermissionRepository.ts` | Create | Port |
| `src/domain/ports/index.ts` | Modify | Re-export the 5 ports |
| `src/infrastructure/adapters/prisma/PrismaRbacUserRepository.ts` | Create | Adapter |
| `src/infrastructure/adapters/prisma/PrismaRbacRoleRepository.ts` | Create | Adapter |
| `src/infrastructure/adapters/prisma/PrismaRbacPermissionRepository.ts` | Create | Adapter |
| `src/infrastructure/adapters/prisma/PrismaRbacUserRoleRepository.ts` | Create | Adapter |
| `src/infrastructure/adapters/prisma/PrismaRbacRolePermissionRepository.ts` | Create | Adapter |
| `src/infrastructure/adapters/in-memory/InMemoryRbacUserRepository.ts` | Create | Test adapter |
| `src/infrastructure/adapters/in-memory/InMemoryRbacRoleRepository.ts` | Create | Test adapter |
| `src/infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository.ts` | Create | Test adapter |
| `src/infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository.ts` | Create | Test adapter |
| `src/infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository.ts` | Create | Test adapter |
| `src/infrastructure/http/middleware/requirePermission.ts` | Create | Middleware factory |
| `src/infrastructure/http/middleware/index.ts` | Modify | Export `requirePermission` |
| `src/infrastructure/http/app.ts` | Modify | Instantiate 5 repos + bind middleware factory. **No route mounting.** ~10 lines appended in existing DI section. God Object debt acknowledged — deferred. |
| `src/__tests__/infrastructure/middleware/requirePermission.test.ts` | Create | Unit + supertest tests |
| `src/__tests__/infrastructure/adapters/in-memory/rbac/*.test.ts` | Create | InMemory contract tests (one per port) |
| `src/__tests__/infrastructure/adapters/prisma/rbac-migration.test.ts` | Create | Integration test asserting seed is present (skipped if no `DATABASE_URL_TEST`) |

## Interfaces / Contracts

### Prisma schema (excerpt)

```prisma
enum RbacAction { read write delete manage }

model RbacModule {
  id          String           @id @default(uuid())
  code        String           @unique          // 'clients', 'billing', ...
  label       String
  createdAt   DateTime         @default(now())
  permissions RbacPermission[]
}

model RbacPermission {
  id        String              @id @default(uuid())
  moduleId  String
  action    RbacAction
  module    RbacModule          @relation(fields: [moduleId], references: [id], onDelete: Restrict)
  grants    RbacRolePermission[]
  @@unique([moduleId, action])
  @@index([moduleId])
}

model RbacRole {
  id          String              @id @default(uuid())
  code        String              @unique  // 'super_admin', 'administrador', ...
  label       String
  isSystem    Boolean             @default(false)
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt
  users       RbacUserRole[]
  permissions RbacRolePermission[]
}

model RbacUser {
  id           String         @id @default(uuid())
  name         String
  email        String
  login        String         @unique
  passwordHash String                                 // NOT NULL — decision #4
  status       String         @default("active")     // 'active' | 'disabled'
  createdAt    DateTime       @default(now())
  updatedAt    DateTime       @updatedAt
  roles        RbacUserRole[]
  @@index([login])
}

model RbacUserRole {
  userId    String
  roleId    String
  createdAt DateTime @default(now())
  user      RbacUser @relation(fields: [userId], references: [id], onDelete: Cascade)
  role      RbacRole @relation(fields: [roleId], references: [id], onDelete: Cascade)
  @@id([userId, roleId])
  @@index([roleId])
}

model RbacRolePermission {
  roleId       String
  permissionId String
  createdAt    DateTime       @default(now())
  role         RbacRole       @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permission   RbacPermission @relation(fields: [permissionId], references: [id], onDelete: Cascade)
  @@id([roleId, permissionId])
  @@index([permissionId])
}
```

Indexes: `RbacUser.login` (unique already creates one, secondary `@@index` documents the hot path used by future `findByLogin`); `RbacPermission(moduleId)` for `listPermissionsForUser` joins.

### Domain types (`src/domain/entities/rbac.ts`)

```ts
export type PermissionAction = 'read' | 'write' | 'delete' | 'manage';

export const RBAC_MODULES = [
  'clients','billing','scheduling','network','admin','monitoring',
  'iclass','gestionReal','reports','tickets','settings','crm','inventory','vehicles',
] as const;
export type RbacModuleCode = typeof RBAC_MODULES[number];

export const SYSTEM_ROLES = [
  'super_admin','administrador','administracion','ventas','noc','tecnico',
] as const;
export type SystemRoleCode = typeof SYSTEM_ROLES[number];

export interface RbacUser { id: string; name: string; email: string; login: string;
  status: 'active'|'disabled'; createdAt: string; updatedAt: string; }
export interface RbacRole { id: string; code: string; label: string; isSystem: boolean; }
export interface RbacModule { id: string; code: RbacModuleCode; label: string; }
export interface RbacPermission { id: string; moduleCode: RbacModuleCode; action: PermissionAction; }
```

### Ports (signatures only — DTOs, never Prisma types)

```ts
// RbacUserRepository.ts
export interface CreateRbacUserInput { name: string; email: string; login: string;
  passwordHash: string; status?: 'active'|'disabled'; }
export interface RbacUserRepository {
  findById(id: string): Promise<RbacUser | null>;
  findByLogin(login: string): Promise<(RbacUser & { passwordHash: string }) | null>;
  listPermissionsForUser(userId: string): Promise<RbacPermission[]>;   // hot path
  listRolesForUser(userId: string): Promise<RbacRole[]>;
  create(input: CreateRbacUserInput): Promise<RbacUser>;
}

// RbacRoleRepository.ts
export interface RbacRoleRepository {
  findById(id: string): Promise<RbacRole | null>;
  findByCode(code: string): Promise<RbacRole | null>;
  listAll(): Promise<RbacRole[]>;
}

// RbacPermissionRepository.ts
export interface RbacPermissionRepository {
  listAll(): Promise<RbacPermission[]>;
  findByModuleAndAction(moduleCode: string, action: PermissionAction): Promise<RbacPermission | null>;
}

// RbacUserRoleRepository.ts
export interface RbacUserRoleRepository {
  assign(userId: string, roleId: string): Promise<void>;
  revoke(userId: string, roleId: string): Promise<void>;
  listForUser(userId: string): Promise<string[]>; // role ids
}

// RbacRolePermissionRepository.ts
export interface RbacRolePermissionRepository {
  grant(roleId: string, permissionId: string): Promise<void>;
  revoke(roleId: string, permissionId: string): Promise<void>;
  listForRole(roleId: string): Promise<string[]>; // permission ids
}
```

`listPermissionsForUser` is implemented in `PrismaRbacUserRepository` as a single query with nested `include`s — no N+1.

### Middleware (`requirePermission.ts`)

```ts
export function requirePermission(
  userRepo: RbacUserRepository,
  module: RbacModuleCode,
  action: PermissionAction,
) {
  return async function guard(req: Request, res: Response, next: NextFunction): Promise<void> {
    const userId = (req as any).user?.id;
    if (!userId) { res.status(401).json({ error:'UNAUTHORIZED', code:'NO_USER_CONTEXT' }); return; }
    const roles = await userRepo.listRolesForUser(userId);
    if (roles.some(r => r.code === 'super_admin')) { next(); return; }
    const perms = await userRepo.listPermissionsForUser(userId);
    const ok = perms.some(p => p.moduleCode === module && p.action === action);
    if (!ok) { res.status(403).json({ error:'FORBIDDEN', code:'PERMISSION_DENIED', module, action }); return; }
    next();
  };
}
```

Factory shape (closes over `userRepo`) keeps it DI-friendly and test-friendly. `req.user` is populated by the existing JWT middleware in `auth.ts`. No cache v1.

## DI wiring in `app.ts` (additions only)

```ts
// near existing repo instantiations
const rbacUserRepo            = new PrismaRbacUserRepository();
const rbacRoleRepo            = new PrismaRbacRoleRepository();
const rbacPermissionRepo      = new PrismaRbacPermissionRepository();
const rbacUserRoleRepo        = new PrismaRbacUserRoleRepository();
const rbacRolePermissionRepo  = new PrismaRbacRolePermissionRepository();

// export factory bound to the repo so routers in future SDDs can use it
export const requirePerm = (m: RbacModuleCode, a: PermissionAction) =>
  requirePermission(rbacUserRepo, m, a);
```

No routes mounted. Known debt: `app.ts` is a 617-line God Object — extraction deferred.

## Testing Strategy

Strict TDD: red → green → refactor. Test seams:

| Layer | What | Approach |
|-------|------|----------|
| Unit | Each `InMemoryRbac*Repository` | Contract test per port (create/find/list edge cases) |
| Unit | `requirePermission` happy path, super_admin short-circuit, 401 (no `req.user`), 403 (no permission), wrong module, wrong action | Supertest on a throwaway Express app, with `InMemoryRbacUserRepository` pre-seeded |
| Integration | Seed migration | Optional test that boots Prisma against `DATABASE_URL_TEST` and asserts 14 modules + 56 permissions + 6 roles present. **Skipped if env var missing** so `npm test` stays green on dev boxes without a DB. |

InMemory adapters are the primary test seam. No Prisma mocks anywhere.

## Migration / Rollout

- Single additive migration `20260529000000_auth_rbac_foundation`.
- Seed inside migration SQL, idempotent: `INSERT … ON CONFLICT (code) DO NOTHING` for modules/permissions/roles, `ON CONFLICT (roleId, permissionId) DO NOTHING` for matrix grants. Re-running the migration is a no-op.
- Prod deploy: GitHub Actions runs `prisma migrate deploy` against `secrets.DATABASE_URL` after push to `main`. Fail-fast.
- Rollback: revert code commit + `DROP TABLE` in cascade order:
  ```sql
  DROP TABLE "RbacRolePermission";
  DROP TABLE "RbacUserRole";
  DROP TABLE "RbacUser";
  DROP TABLE "RbacPermission";
  DROP TABLE "RbacRole";
  DROP TABLE "RbacModule";
  DROP TYPE "RbacAction";
  ```
  Safe because no existing table FKs into the new ones.

## Coexistence with legacy `Admin`

- `Admin`, `AdminRole_Definition`, `auth.routes.ts`, `admin.routes.ts`, `role.routes.ts`, `PrismaAdminRepository`, `PrismaRoleRepository` — **untouched**.
- Two user tables in prod is a known temporary state. Data migration `Admin → RbacUser` is SDD #6. Login flow switch is SDD #5.
- `requirePermission` is shipped but mounted on zero routes — SDD #4 wires it. Rollback safe.

## Open Questions

None. All 5 proposal open questions were resolved in the locked decisions.
