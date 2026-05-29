# Spec: rbac-effective-permissions

## Capability
Use case `ResolveUserPermissions(userId: string): Promise<string[]>`

Resolves the flat list of permission codes for a given user, applying the
super_admin sentinel rule. This is the single source of truth consumed by
`/api/auth/me` and future audit layers.

---

## Context

- SDD #1 delivered: `RbacUserRoleRepository`, `RbacRolePermissionRepository`,
  `RbacPermissionRepository`, `RbacRoleRepository` — all ports + adapters.
- The middleware `requirePermission` already does a per-request DB walk; this
  use case makes it cacheable and serialisable via `/me`.
- No new ports are needed. Use case reads via existing ports injected at
  construction time.

---

## Interfaces

### Input
```ts
userId: string   // non-empty UUID
```

### Output
```ts
string[]         // permission codes, e.g. ["scheduling.read", "tickets.write"]
                 // OR ["*"] for super_admin
                 // OR [] for user with no roles or roles with no permissions
```

### Permission code format
```
{moduleCode}.{action}
```
Examples: `scheduling.delete`, `tickets.close`, `rbac.manage_roles`

---

## Requirements

### R1 — super_admin short-circuit
If the user has a role with `code === 'super_admin'`, return `["*"]` immediately
without evaluating any permission rows.

### R2 — union across roles
For a user with N roles, collect all `permissionId` values from
`RbacRolePermissionRepository.listForRole(roleId)` for each role. Resolve each
permission ID to a code via `RbacPermissionRepository.listAll()` (or
find-by-id variant once available). Return the flat deduplicated list.

### R3 — empty roles
If `RbacUserRoleRepository.listForUser(userId)` returns `[]`, return `[]`.

### R4 — roles with no permissions
If all roles exist but have zero granted permissions, return `[]`.

### R5 — deduplication
If the same permission is granted via two different roles, the code appears only
once in the output.

### R6 — input validation
If `userId` is empty or not a string, throw `ValidationError` with code
`INVALID_USER_ID`.

### R7 — user not found is not an error
If no roles are found for the userId (user has no roles), return `[]`.
The caller is responsible for ensuring the userId is valid.

---

## Scenarios (= test cases)

### S1 — super_admin returns sentinel
```
Given: user has role code "super_admin"
When:  ResolveUserPermissions(userId)
Then:  returns ["*"]
And:   no permission lookup is performed (short-circuit verified via spy)
```

### S2 — single role with permissions
```
Given: user has role "tecnico" with permissions [scheduling.read, scheduling.write]
When:  ResolveUserPermissions(userId)
Then:  returns ["scheduling.read", "scheduling.write"] (order not guaranteed)
```

### S3 — multiple roles, union deduplicated
```
Given: user has roles ["noc", "tecnico"]
  noc permissions: [monitoring.read, monitoring.acknowledge_alert, scheduling.read]
  tecnico permissions: [scheduling.read, scheduling.write, scheduling.delete]
When:  ResolveUserPermissions(userId)
Then:  returns exactly 5 codes (scheduling.read deduplicated)
  ["monitoring.read", "monitoring.acknowledge_alert",
   "scheduling.read", "scheduling.write", "scheduling.delete"]
  (any order)
```

### S4 — user with no roles
```
Given: RbacUserRoleRepository.listForUser returns []
When:  ResolveUserPermissions(userId)
Then:  returns []
```

### S5 — user with roles but no permissions granted
```
Given: user has role "ventas" with no permissions granted
When:  ResolveUserPermissions(userId)
Then:  returns []
```

### S6 — invalid userId (empty string)
```
Given: userId = ""
When:  ResolveUserPermissions(userId)
Then:  throws ValidationError with code INVALID_USER_ID
```

### S7 — permission code format is correct
```
Given: user has role with a permission on module "scheduling", action "delete"
When:  ResolveUserPermissions(userId)
Then:  returned array contains exactly "scheduling.delete"
```

---

## Implementation notes

- Use case file: `src/application/use-cases/rbac/ResolveUserPermissions.ts`
- Constructor injection: `RbacUserRoleRepository`, `RbacRolePermissionRepository`,
  `RbacPermissionRepository`
- Do NOT call `userRepo.listPermissionsForUser` — that method on
  `RbacUserRepository` is the middleware's internal path. This use case uses
  the finer-grained ports to remain independently testable.
- Permission code derivation: `${permission.moduleCode}.${permission.action}`
- Sort output for stable snapshots in tests (optional, not a contract requirement).
- Test file: `src/__tests__/application/rbac/ResolveUserPermissions.test.ts`
  using InMemory adapters (NO Prisma mocks).

---

## Out of scope
- Caching (deferred to SDD #5)
- Per-resource ACLs
- Role hierarchy / inheritance
