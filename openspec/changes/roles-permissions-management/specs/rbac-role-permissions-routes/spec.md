# Spec: rbac-role-permissions-routes

## Capability
New HTTP endpoints for reading and writing permissions on a role.
Used by the FE permission matrix UI.

---

## Endpoints

### GET /api/admin/rbac/roles/:id/permissions
Returns all permissions currently granted to a role.

**Auth**: JWT required (`authMiddleware`).
**Authorization**: `requirePerm('rbac', 'manage_roles')`.

#### Response 200
```ts
{
  permissions: Array<{
    id: string;
    moduleCode: string;
    action: string;
    moduleLabel: string;   // for display in FE matrix header
  }>;
}
```

#### Errors
- `401` — no valid JWT
- `403` — PERMISSION_DENIED (lacks `rbac.manage_roles`)
- `404 ROLE_NOT_FOUND` — role id does not exist

---

### PUT /api/admin/rbac/roles/:id/permissions
Bulk replace: atomically sets the full permission set for a role.
All previously granted permissions not in the new list are revoked.
All permissions in the new list not yet granted are added.

**Auth**: JWT required.
**Authorization**: `requirePerm('rbac', 'manage_roles')`.

#### Request body
```ts
{
  permissionIds: string[];   // array of RbacPermission UUIDs
}
```

#### Response 200
```ts
{
  permissions: Array<{
    id: string;
    moduleCode: string;
    action: string;
    moduleLabel: string;
  }>;
}
```

#### Errors
- `400 SUPER_ADMIN_IMMUTABLE` — attempt to modify super_admin role permissions
- `400 INVALID_PERMISSION_IDS` — one or more permissionIds do not exist
- `400 VALIDATION_ERROR` — body is missing `permissionIds` or it is not an array
- `401` — unauthenticated
- `403` — PERMISSION_DENIED
- `404 ROLE_NOT_FOUND` — role id does not exist

---

### GET /api/admin/rbac/permissions
Returns the full permission catalog (all modules × all actions).
Used by the FE to render matrix column headers and rows.

**Auth**: JWT required.
**Authorization**: `requirePerm('rbac', 'manage_roles')`.

#### Response 200
```ts
{
  permissions: Array<{
    id: string;
    moduleCode: string;
    action: string;
    moduleLabel: string;
  }>;
}
```

---

## Use cases required

### ListRolePermissions(roleId): Promise<RbacPermissionWithModule[]>
- Validates roleId non-empty
- Resolves role via `RbacRoleRepository.findById` → 404 if null
- Gets permissionIds via `RbacRolePermissionRepository.listForRole(roleId)`
- Gets full permissions via `RbacPermissionRepository.listAll()` + join
- Returns array with moduleLabel resolved from `RbacModuleRepository` (or joins)

### SetRolePermissions(roleId, permissionIds): Promise<RbacPermissionWithModule[]>
- Validates roleId + permissionIds
- Resolves role → 404 if null
- Throws `ForbiddenError` with code `SUPER_ADMIN_IMMUTABLE` if `role.code === 'super_admin'`
- Validates all permissionIds exist → `ValidationError INVALID_PERMISSION_IDS` if any missing
- **Atomic replace**:
  - current = `RbacRolePermissionRepository.listForRole(roleId)`
  - toRevoke = current - incoming
  - toGrant  = incoming - current
  - call `revoke` for each toRevoke, `grant` for each toGrant
- Returns new full permission list

### Port addition: `RbacRolePermissionRepository.replaceForRole`
Preferred implementation to atomically replace in a single DB transaction:
```ts
replaceForRole(roleId: string, permissionIds: string[]): Promise<void>;
```
Prisma implementation: `deleteMany + createMany` inside `$transaction`.
InMemory: delete old set, insert new set.

---

## Requirements

### R1 — super_admin is immutable
PUT on super_admin role returns `400 SUPER_ADMIN_IMMUTABLE` regardless of
the permissionIds provided.

### R2 — validation before mutation
All permissionIds are validated to exist BEFORE any revoke/grant is executed.

### R3 — atomic replace
The set of permissions after PUT equals exactly the requested `permissionIds`.
No partial state on failure.

### R4 — catalog endpoint is read-only
GET /api/admin/rbac/permissions has no body and performs no mutations.

### R5 — non-system roles can be edited
Custom roles (isSystem=false) can have their permissions freely replaced.
System roles OTHER than super_admin can also be edited (admin, noc, etc.).

---

## Scenarios (= test cases)

### S1 — list role permissions
```
Given: role "tecnico" has permissions [scheduling.read, scheduling.write]
When:  GET /api/admin/rbac/roles/:id/permissions (as rbac.manage_roles user)
Then:  200 { permissions: [scheduling.read entry, scheduling.write entry] }
```

### S2 — list permissions — role not found
```
Given: roleId = "nonexistent-uuid"
When:  GET /api/admin/rbac/roles/:id/permissions
Then:  404 { code: "ROLE_NOT_FOUND" }
```

### S3 — set permissions — happy path
```
Given: role "tecnico" currently has [scheduling.read]
When:  PUT /api/admin/rbac/roles/:id/permissions
       body: { permissionIds: [scheduling.read.id, scheduling.delete.id] }
Then:  200 { permissions: [scheduling.read entry, scheduling.delete entry] }
And:   scheduling.write is NOT in role's permissions
```

### S4 — set permissions — super_admin immutable
```
Given: role with code "super_admin"
When:  PUT /api/admin/rbac/roles/:id/permissions
       body: { permissionIds: [] }
Then:  400 { code: "SUPER_ADMIN_IMMUTABLE" }
```

### S5 — set permissions — invalid permissionId
```
Given: body contains a permissionId that does not exist
When:  PUT /api/admin/rbac/roles/:id/permissions
Then:  400 { code: "INVALID_PERMISSION_IDS" }
```

### S6 — set permissions — empty array (clear all)
```
Given: role "noc" has 3 permissions
When:  PUT /api/admin/rbac/roles/:id/permissions body: { permissionIds: [] }
Then:  200 { permissions: [] }
And:   role has no permissions
```

### S7 — unauthenticated
```
Given: no auth cookie
When:  GET or PUT /api/admin/rbac/roles/:id/permissions
Then:  401
```

### S8 — unauthorized (lacks rbac.manage_roles)
```
Given: authenticated user lacks rbac.manage_roles
When:  GET /api/admin/rbac/roles/:id/permissions
Then:  403 { code: "PERMISSION_DENIED" }
```

### S9 — catalog list
```
Given: 25 modules × 4 base + 24 sub-actions = 124 permissions in DB
When:  GET /api/admin/rbac/permissions
Then:  200 { permissions: array of 124 items }
And:   each item has { id, moduleCode, action, moduleLabel }
```

---

## Implementation notes

- New use case files:
  - `src/application/use-cases/rbac/ListRolePermissions.ts`
  - `src/application/use-cases/rbac/SetRolePermissions.ts`
- Port addition: `replaceForRole` on `RbacRolePermissionRepository`
- New routes added to existing `role.routes.ts` OR in a new `rbacPermission.routes.ts`.
  Prefer adding to `role.routes.ts` to keep RBAC routes co-located.
- Mount point: `/api/admin/rbac/roles` (already in `app.ts` if SDD #2 wired it).
  Catalog endpoint `/api/admin/rbac/permissions` needs its own mount or inline in the roles router.
- Test files:
  - `src/__tests__/application/rbac/ListRolePermissions.test.ts`
  - `src/__tests__/application/rbac/SetRolePermissions.test.ts`
  - `src/__tests__/infrastructure/http/routes/rbacRolePermissions.routes.test.ts` (supertest)
