# Spec — rbac-user-roles (SDD #2 · BE Capability 2)

**Change**: user-management-crud
**Layer**: Application (role-assignment use cases)
**Depends on**: SDD #1 ports — `RbacUserRoleRepository`, `RbacRoleRepository`, `RbacUserRepository`

---

## Overview

Four use cases that manage the many-to-many relationship between `RbacUser` and `RbacRole`.
All reside in `src/application/use-cases/rbac/`. They reuse the existing ports from SDD #1
without modification (except the new `list()` on `RbacUserRepository`).

The `super_admin` last-guardian invariant is enforced here (in addition to DeleteRbacUser):
any operation that would leave **zero** users with role `super_admin` is rejected.

---

## Domain errors

| Code | HTTP | Thrown by |
|------|------|-----------|
| `USER_NOT_FOUND` | 404 | all 4 use cases |
| `ROLE_NOT_FOUND` | 404 | SetRolesForUser, AssignRoleToUser, RemoveRoleFromUser |
| `CANNOT_REMOVE_LAST_SUPER_ADMIN` | 403 | SetRolesForUser, RemoveRoleFromUser |

---

## Use cases

### UC-7 · ListRolesForUser

**File**: `src/application/use-cases/rbac/ListRolesForUser.ts`

```ts
class ListRolesForUser {
  constructor(private users: RbacUserRepository, private userRoles: RbacUserRoleRepository, private roles: RbacRoleRepository)
  execute(userId: string): Promise<RbacRoleDto[]>
}
```

**Requirements**:
- R7.1 Throws `USER_NOT_FOUND` if user does not exist.
- R7.2 Returns list of full `RbacRoleDto` objects (id, code, label, isSystem).
- R7.3 Returns empty array `[]` if user has no roles.

**Scenarios**:

WHEN userId exists and has 2 roles assigned  
THEN returns array of 2 `RbacRoleDto` with correct fields

WHEN userId exists and has 0 roles assigned  
THEN returns `[]`

WHEN userId does not exist  
THEN throws `USER_NOT_FOUND`

---

### UC-8 · AssignRoleToUser

**File**: `src/application/use-cases/rbac/AssignRoleToUser.ts`

```ts
class AssignRoleToUser {
  constructor(private users: RbacUserRepository, private roles: RbacRoleRepository, private userRoles: RbacUserRoleRepository)
  execute(userId: string, roleId: string): Promise<void>
}
```

**Requirements**:
- R8.1 Throws `USER_NOT_FOUND` if user does not exist.
- R8.2 Throws `ROLE_NOT_FOUND` if role does not exist.
- R8.3 Assignment is **idempotent** — calling twice with same `(userId, roleId)` has no error; second call is a no-op.
- R8.4 Delegates to `RbacUserRoleRepository.assign` (which has upsert semantics).

**Scenarios**:

WHEN userId and roleId both exist  
THEN `assign(userId, roleId)` is called, returns void

WHEN called twice with same (userId, roleId)  
THEN no error on second call (idempotent)

WHEN userId does not exist  
THEN throws `USER_NOT_FOUND`

WHEN roleId does not exist  
THEN throws `ROLE_NOT_FOUND`

---

### UC-9 · RemoveRoleFromUser

**File**: `src/application/use-cases/rbac/RemoveRoleFromUser.ts`

```ts
class RemoveRoleFromUser {
  constructor(private users: RbacUserRepository, private roles: RbacRoleRepository, private userRoles: RbacUserRoleRepository)
  execute(userId: string, roleId: string): Promise<void>
}
```

**Requirements**:
- R9.1 Throws `USER_NOT_FOUND` if user does not exist.
- R9.2 Throws `ROLE_NOT_FOUND` if role does not exist.
- R9.3 **Last-super_admin guard**: if the role being removed is `super_admin` AND after removal the system would have 0 users with super_admin → throws `CANNOT_REMOVE_LAST_SUPER_ADMIN`.
  - Algorithm: load all users with super_admin; if `[userId]` is the only one → reject.
- R9.4 If role is not assigned to user → no-op (revoke is idempotent, no error).
- R9.5 Delegates to `RbacUserRoleRepository.revoke`.

**Scenarios**:

WHEN removing a non-super_admin role from a user who has it  
THEN role is revoked

WHEN removing super_admin from a user who is the ONLY super_admin  
THEN throws `CANNOT_REMOVE_LAST_SUPER_ADMIN`

WHEN removing super_admin from a user who is ONE OF 2 super_admins  
THEN revoke succeeds (other super_admin remains)

WHEN role is not assigned to user (revoke non-assigned)  
THEN no error (idempotent)

WHEN userId does not exist  
THEN throws `USER_NOT_FOUND`

WHEN roleId does not exist  
THEN throws `ROLE_NOT_FOUND`

---

### UC-10 · SetRolesForUser

**File**: `src/application/use-cases/rbac/SetRolesForUser.ts`

```ts
class SetRolesForUser {
  constructor(private users: RbacUserRepository, private roles: RbacRoleRepository, private userRoles: RbacUserRoleRepository)
  execute(userId: string, roleIds: string[]): Promise<RbacRoleDto[]>
}
```

**Requirements**:
- R10.1 Throws `USER_NOT_FOUND` if user does not exist.
- R10.2 Each roleId must resolve — throws `ROLE_NOT_FOUND` for first invalid id.
- R10.3 **Last-super_admin guard**: if `roleIds` does NOT include the `super_admin` role, AND this user is currently the ONLY user with super_admin → throws `CANNOT_REMOVE_LAST_SUPER_ADMIN`.
- R10.4 **Idempotent diff algorithm**:
  1. Load current assignments: `currentIds = await userRoles.listForUser(userId)`
  2. `toAdd = roleIds.filter(id => !currentIds.includes(id))`
  3. `toRemove = currentIds.filter(id => !roleIds.includes(id))`
  4. Call `assign` for each in `toAdd`, `revoke` for each in `toRemove`
- R10.5 Returns the final list of assigned roles as `RbacRoleDto[]`.
- R10.6 **Known limitation (documented)**: concurrent SetRolesForUser calls on the same user are last-write-wins. Acceptable for SDD #2 (low concurrency). Prisma adapter may wrap in `$transaction` for atomicity but the port does not mandate it.

**Scenarios**:

WHEN user has roles [A, B] and new set is [B, C]  
THEN A is revoked, C is assigned, B is unchanged  
AND returned DTOs are [B, C]

WHEN user has role [super_admin] and new set is [] (empty)  
THEN throws `CANNOT_REMOVE_LAST_SUPER_ADMIN` (would leave 0 super_admins)

WHEN user has role [super_admin] and 1 other user also has super_admin, new set is []  
THEN succeeds (other super_admin still exists)

WHEN new set contains a non-existent roleId  
THEN throws `ROLE_NOT_FOUND`

WHEN called twice with same roleIds (idempotent repeat)  
THEN second call returns same DTOs, no side-effects

WHEN userId does not exist  
THEN throws `USER_NOT_FOUND`

---

## Test matrix

| Use case | Suite | Adapter |
|----------|-------|---------|
| ListRolesForUser | `src/__tests__/application/rbac/ListRolesForUser.test.ts` | InMemory |
| AssignRoleToUser | `src/__tests__/application/rbac/AssignRoleToUser.test.ts` | InMemory |
| RemoveRoleFromUser | `src/__tests__/application/rbac/RemoveRoleFromUser.test.ts` | InMemory |
| SetRolesForUser | `src/__tests__/application/rbac/SetRolesForUser.test.ts` | InMemory |
