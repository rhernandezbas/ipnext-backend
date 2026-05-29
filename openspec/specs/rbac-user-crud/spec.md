# Spec — rbac-user-crud (SDD #2 · BE Capability 1)

**Change**: user-management-crud
**Layer**: Application (use cases + DTOs)
**Depends on**: SDD #1 ports — `RbacUserRepository`, `RbacRoleRepository`, `RbacUserRoleRepository`
**New port**: `PasswordHasher` (hash / compare)

---

## Overview

Ten use cases that implement the full lifecycle of `RbacUser` entities. All reside under
`src/application/use-cases/rbac/`. All consume ports exclusively — zero imports from
`@infrastructure/*`. A shared DTO module at `src/application/dto/rbacUser.dto.ts` defines the
output shapes; `passwordHash` is NEVER present in any DTO.

---

## Ports consumed

| Port | Import path |
|------|-------------|
| `RbacUserRepository` | `@domain/ports/RbacUserRepository` |
| `RbacRoleRepository` | `@domain/ports/RbacRoleRepository` |
| `RbacUserRoleRepository` | `@domain/ports/RbacUserRoleRepository` |
| `PasswordHasher` | `@domain/ports/PasswordHasher` _(new — this SDD)_ |

---

## New port: PasswordHasher

```ts
// src/domain/ports/PasswordHasher.ts
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  compare(plain: string, hash: string): Promise<boolean>;
}
```

**Adapters**:
- `BcryptPasswordHasher` (`src/infrastructure/adapters/bcrypt/BcryptPasswordHasher.ts`) — uses `bcryptjs` cost 10 (matching `auth.routes.ts`).
- `InMemoryPasswordHasher` — prefixes `hashed::` to plain text; compare checks `hash === 'hashed::' + plain`. Zero async cost — suitable for unit tests.

---

## DTOs

File: `src/application/dto/rbacUser.dto.ts`

```ts
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

export interface RbacUserWithRolesDto extends RbacUserDto {
  roles: RbacRoleDto[];
}

export interface RbacRoleDto {
  id: string;
  code: string;
  label: string;
  isSystem: boolean;
}

export interface CreateRbacUserDto {
  name: string;
  email: string;
  login: string;
  password: string;       // plain — hashed by use case
  roleIds: string[];
}

export interface UpdateRbacUserDto {
  name?: string;
  email?: string;
  login?: string;
  password?: string;      // absent or empty string → no change
  status?: 'active' | 'disabled';
}
```

**Type-level safety**: `RbacUserDto` MUST NOT declare `passwordHash`. Any attempt to assign
`{ ...user, passwordHash }` to `RbacUserDto` will fail at compile time.

**Mapper**:
```ts
function toRbacUserDto(user: RbacUser): RbacUserDto  // strips nothing — passwordHash absent in RbacUser already
function toRbacUserWithRolesDto(user: RbacUser, roles: RbacRole[]): RbacUserWithRolesDto
```

---

## Domain errors

All errors are thrown as `DomainError` (existing class) with a `code` field.

| Code | HTTP | Thrown by |
|------|------|-----------|
| `USER_NOT_FOUND` | 404 | GetRbacUser, UpdateRbacUser, DeleteRbacUser, ChangeRbacUserPassword |
| `LOGIN_ALREADY_TAKEN` | 409 | CreateRbacUser, UpdateRbacUser |
| `EMAIL_ALREADY_TAKEN` | 409 | CreateRbacUser, UpdateRbacUser |
| `AT_LEAST_ONE_ROLE_REQUIRED` | 400 | CreateRbacUser |
| `ROLE_NOT_FOUND` | 404 | CreateRbacUser, AssignRoleToUser |
| `PASSWORD_TOO_SHORT` | 400 | CreateRbacUser, ChangeRbacUserPassword |
| `CANNOT_DELETE_SELF` | 403 | DeleteRbacUser |
| `CANNOT_REMOVE_LAST_SUPER_ADMIN` | 403 | DeleteRbacUser, SetRolesForUser, RemoveRoleFromUser |
| `INVALID_OLD_PASSWORD` | 403 | ChangeRbacUserPassword (self-change path) |

---

## Use cases

### UC-1 · ListRbacUsers

**File**: `src/application/use-cases/rbac/ListRbacUsers.ts`

```ts
class ListRbacUsers {
  constructor(private users: RbacUserRepository, private userRoles: RbacUserRoleRepository, private roles: RbacRoleRepository)
  execute(): Promise<RbacUserWithRolesDto[]>
}
```

**Requirements**:
- R1.1 Returns all users (no pagination — expected < 100).
- R1.2 Each DTO includes `roles[]` with full role objects.
- R1.3 `passwordHash` NEVER present in output.
- R1.4 Order: by `createdAt ASC`.

**Scenarios**:

WHEN the repository has 0 users  
THEN returns empty array `[]`

WHEN the repository has 2 users (alice with super_admin, bob with administrador)  
THEN returns array of 2 `RbacUserWithRolesDto`, each with correct roles  
AND neither DTO contains `passwordHash`

---

### UC-2 · GetRbacUser

**File**: `src/application/use-cases/rbac/GetRbacUser.ts`

```ts
class GetRbacUser {
  constructor(private users: RbacUserRepository, private userRoles: RbacUserRoleRepository, private roles: RbacRoleRepository)
  execute(id: string): Promise<RbacUserWithRolesDto>
}
```

**Requirements**:
- R2.1 Returns the user with their roles.
- R2.2 Throws `USER_NOT_FOUND` if id does not exist.
- R2.3 `passwordHash` NEVER present in output.

**Scenarios**:

WHEN id exists  
THEN returns `RbacUserWithRolesDto` with correct fields and roles

WHEN id does not exist  
THEN throws DomainError `USER_NOT_FOUND`

---

### UC-3 · CreateRbacUser

**File**: `src/application/use-cases/rbac/CreateRbacUser.ts`

```ts
class CreateRbacUser {
  constructor(private users: RbacUserRepository, private roles: RbacRoleRepository, private userRoles: RbacUserRoleRepository, private hasher: PasswordHasher)
  execute(dto: CreateRbacUserDto): Promise<RbacUserWithRolesDto>
}
```

**Requirements**:
- R3.1 `name`, `email`, `login`, `password` are all required non-empty strings.
- R3.2 `password` must be ≥ 8 chars — throws `PASSWORD_TOO_SHORT` otherwise.
- R3.3 `roleIds` must have ≥ 1 entry — throws `AT_LEAST_ONE_ROLE_REQUIRED` otherwise.
- R3.4 Each roleId must resolve via `RbacRoleRepository.findById` — throws `ROLE_NOT_FOUND` for first invalid id.
- R3.5 `login` must be unique — throws `LOGIN_ALREADY_TAKEN` if `findByLogin` returns non-null.
- R3.6 `email` must be unique — throws `EMAIL_ALREADY_TAKEN` if `findByEmail` returns non-null.
- R3.7 Password is hashed via `PasswordHasher.hash` before persisting.
- R3.8 User is created with `status: 'active'`.
- R3.9 All roleIds are assigned via `RbacUserRoleRepository.assign` after user creation.
- R3.10 Returns `RbacUserWithRolesDto` including the assigned roles.

**Scenarios**:

WHEN valid dto with login "alice", email "alice@test.com", password "secret12", roleIds=[existingRoleId]  
THEN user is created, roles assigned, returned DTO has correct fields  
AND `passwordHash` is not present in DTO

WHEN password is "short" (5 chars)  
THEN throws `PASSWORD_TOO_SHORT`

WHEN `roleIds` is `[]`  
THEN throws `AT_LEAST_ONE_ROLE_REQUIRED`

WHEN `roleIds` contains a non-existent roleId  
THEN throws `ROLE_NOT_FOUND`

WHEN login already taken  
THEN throws `LOGIN_ALREADY_TAKEN`

WHEN email already taken  
THEN throws `EMAIL_ALREADY_TAKEN`

WHEN valid dto  
THEN stored `passwordHash` equals `hasher.hash(password)` (verified via InMemoryPasswordHasher prefix)

---

### UC-4 · UpdateRbacUser

**File**: `src/application/use-cases/rbac/UpdateRbacUser.ts`

```ts
class UpdateRbacUser {
  constructor(private users: RbacUserRepository, private hasher: PasswordHasher)
  execute(id: string, dto: UpdateRbacUserDto): Promise<RbacUserDto>
}
```

**Requirements**:
- R4.1 Throws `USER_NOT_FOUND` if user does not exist.
- R4.2 Only provided fields are updated (partial merge).
- R4.3 If `password` is absent or empty string (`''`) → password is NOT changed.
- R4.4 If `password` is non-empty → must be ≥ 8 chars (throws `PASSWORD_TOO_SHORT`), then hashed and stored.
- R4.5 If `login` is provided and differs from current → validate uniqueness (throws `LOGIN_ALREADY_TAKEN`).
- R4.6 If `email` is provided and differs from current → validate uniqueness (throws `EMAIL_ALREADY_TAKEN`).
- R4.7 Returns `RbacUserDto` (no roles — caller uses GetRbacUser if needed).

**Scenarios**:

WHEN user exists, dto = `{ name: "Alice Updated" }`  
THEN name is updated, other fields unchanged, DTO returned with new name

WHEN `password` is `""` (empty string)  
THEN passwordHash is NOT modified

WHEN `password` is `"newpass1"` (≥8 chars)  
THEN passwordHash is updated to `hasher.hash("newpass1")`

WHEN `password` is `"short"` (5 chars)  
THEN throws `PASSWORD_TOO_SHORT`

WHEN new login collides with existing user  
THEN throws `LOGIN_ALREADY_TAKEN`

WHEN id does not exist  
THEN throws `USER_NOT_FOUND`

---

### UC-5 · DeleteRbacUser

**File**: `src/application/use-cases/rbac/DeleteRbacUser.ts`

```ts
class DeleteRbacUser {
  constructor(private users: RbacUserRepository, private userRoles: RbacUserRoleRepository)
  execute(id: string, requestingUserId: string): Promise<void>
}
```

**Requirements**:
- R5.1 Throws `USER_NOT_FOUND` if user does not exist.
- R5.2 `requestingUserId` is the authenticated user's id. If `id === requestingUserId` → throws `CANNOT_DELETE_SELF`.
- R5.3 Before deleting: check if the target user is the LAST remaining user with role `super_admin`. If yes → throws `CANNOT_REMOVE_LAST_SUPER_ADMIN`. Check: count users with super_admin role; if target is one of them AND total == 1 → reject.
- R5.4 Deletes all `RbacUserRole` assignments for the user first, then deletes the user.
- R5.5 Returns `void`.

**Scenarios**:

WHEN deleting a non-self, non-last-super_admin user  
THEN user and their role assignments are removed

WHEN `id === requestingUserId`  
THEN throws `CANNOT_DELETE_SELF` (no deletion occurs)

WHEN target is the sole user with super_admin role  
THEN throws `CANNOT_REMOVE_LAST_SUPER_ADMIN`

WHEN target is one of 2 users with super_admin role  
THEN deletion succeeds (sole-super_admin check passes)

WHEN id does not exist  
THEN throws `USER_NOT_FOUND`

---

### UC-6 · ChangeRbacUserPassword

**File**: `src/application/use-cases/rbac/ChangeRbacUserPassword.ts`

```ts
interface ChangeRbacUserPasswordDto {
  newPassword: string;
  oldPassword?: string;   // required only for self-change
}

class ChangeRbacUserPassword {
  constructor(private users: RbacUserRepository, private hasher: PasswordHasher)
  /**
   * @param isAdminManaged - true when an admin changes another user's password
   *                         (oldPassword check skipped). false when user self-changes
   *                         (oldPassword required and verified).
   */
  execute(targetUserId: string, dto: ChangeRbacUserPasswordDto, isAdminManaged: boolean): Promise<void>
}
```

**Password change policy**:
| Caller | `isAdminManaged` | `oldPassword` required? |
|--------|-----------------|------------------------|
| Admin changing another user | `true` | No — skipped |
| User changing own password | `false` | Yes — must match current hash |

Note: whether the caller is an admin or self is determined at the route level (HTTP context). The use case receives the resolved boolean. This separation keeps the use case testable without HTTP context.

**Requirements**:
- R6.1 Throws `USER_NOT_FOUND` if target user does not exist.
- R6.2 `newPassword` must be ≥ 8 chars — throws `PASSWORD_TOO_SHORT`.
- R6.3 If `isAdminManaged = false` AND `oldPassword` is absent → throws `INVALID_OLD_PASSWORD`.
- R6.4 If `isAdminManaged = false` AND `oldPassword` present → compare with stored hash; throws `INVALID_OLD_PASSWORD` if mismatch.
- R6.5 Hashes `newPassword` and persists.

**Scenarios**:

WHEN admin changes another user's password with valid `newPassword`  
THEN passwordHash updated, no old password check

WHEN user self-changes with correct `oldPassword` and valid `newPassword`  
THEN passwordHash updated

WHEN user self-changes with wrong `oldPassword`  
THEN throws `INVALID_OLD_PASSWORD`

WHEN `newPassword` is 5 chars  
THEN throws `PASSWORD_TOO_SHORT`

WHEN user does not exist  
THEN throws `USER_NOT_FOUND`

---

## RbacUserRepository — new methods required

The existing `RbacUserRepository` port needs additions to support these use cases. New methods:

```ts
// Add to RbacUserRepository interface:
list(): Promise<RbacUser[]>;
update(id: string, patch: Partial<Pick<RbacUser, 'name' | 'email' | 'login' | 'status'>> & { passwordHash?: string }): Promise<RbacUser>;
delete(id: string): Promise<void>;
```

These additions are backwards-compatible (existing adapters just add the methods).

---

## Test matrix

| Use case | Suite | Adapter |
|----------|-------|---------|
| ListRbacUsers | `src/__tests__/application/rbac/ListRbacUsers.test.ts` | InMemory |
| GetRbacUser | `src/__tests__/application/rbac/GetRbacUser.test.ts` | InMemory |
| CreateRbacUser | `src/__tests__/application/rbac/CreateRbacUser.test.ts` | InMemory |
| UpdateRbacUser | `src/__tests__/application/rbac/UpdateRbacUser.test.ts` | InMemory |
| DeleteRbacUser | `src/__tests__/application/rbac/DeleteRbacUser.test.ts` | InMemory |
| ChangeRbacUserPassword | `src/__tests__/application/rbac/ChangeRbacUserPassword.test.ts` | InMemory |

All tests use `InMemoryPasswordHasher`. No `bcryptjs` in unit tests.
