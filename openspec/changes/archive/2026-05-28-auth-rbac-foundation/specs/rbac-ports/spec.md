# rbac-ports Specification

## Purpose

Define the five domain port interfaces and their required methods. All methods return domain DTOs — never raw Prisma objects. These ports live in `src/domain/ports/` and are the ONLY way application and infrastructure layers interact with RBAC data.

## Requirements

### Requirement: RbacUserRepository port

The system MUST expose an `RbacUserRepository` interface with:

| Method | Signature | Returns |
|--------|-----------|---------|
| `findById` | `(id: string)` | `RbacUser \| null` |
| `findByLogin` | `(login: string)` | `(RbacUser & { passwordHash: string }) \| null` |
| `findByEmail` | `(email: string)` | `RbacUser \| null` |
| `create` | `(data: CreateRbacUserInput)` | `RbacUser` |
| `updateLastLogin` | `(id: string, at: Date)` | `void` |
| `listRolesForUser` | `(userId: string)` | `RbacRole[]` |
| `listPermissionsForUser` | `(userId: string)` | `RbacPermission[]` |

`RbacUser`: `{ id, name, email, login, status, createdAt, updatedAt, lastLoginAt: string \| null }`. `passwordHash` is NEVER included in the DTO. `findByLogin` is the ONLY method that returns `passwordHash` (authentication flow).

#### Scenario: findByLogin returns null for unknown login

- GIVEN no user with `login: "ghost"` exists
- WHEN `findByLogin("ghost")` is called
- THEN result is `null`

#### Scenario: create returns DTO without passwordHash

- GIVEN valid `CreateRbacUserInput` with all required fields
- WHEN `create(input)` is called
- THEN returned `RbacUserDto` does NOT contain `passwordHash`

### Requirement: RbacRoleRepository port

The system MUST expose an `RbacRoleRepository` interface with:

| Method | Signature | Returns |
|--------|-----------|---------|
| `findById` | `(id: string)` | `RbacRole \| null` |
| `findByCode` | `(code: string)` | `RbacRole \| null` |
| `listAll` | `()` | `RbacRole[]` |

`RbacRole`: `{ id, code, label, isSystem }`. Note: field is `label` (not `name`), no `description` or `createdAt` on the domain type.

#### Scenario: findByCode returns null for unknown code

- GIVEN no role with `code: "ghost"` exists
- WHEN `findByCode("ghost")` is called
- THEN result is `null`

### Requirement: RbacPermissionRepository port

The system MUST expose an `RbacPermissionRepository` interface with:

| Method | Signature | Returns |
|--------|-----------|---------|
| `listAll` | `()` | `RbacPermission[]` |
| `findByModuleAndAction` | `(moduleCode: string, action: PermissionAction)` | `RbacPermission \| null` |

`RbacPermission`: `{ id, moduleCode, action }`.

#### Scenario: findByModuleAndAction returns null for unknown combination

- GIVEN no permission for `(moduleCode: "clients", action: "delete")` exists
- WHEN `findByModuleAndAction("clients", "delete")` is called
- THEN result is `null`

### Requirement: RbacUserRoleRepository port

The system MUST expose an `RbacUserRoleRepository` interface with:

| Method | Signature | Returns |
|--------|-----------|---------|
| `assign` | `(userId: string, roleId: string)` | `void` |
| `revoke` | `(userId: string, roleId: string)` | `void` |
| `listForUser` | `(userId: string)` | `string[]` (role IDs) |

#### Scenario: assign is idempotent on duplicate

- GIVEN `(userId, roleId)` already assigned
- WHEN `assign(userId, roleId)` is called again
- THEN no error is thrown (upsert or ignore-conflict semantics)

#### Scenario: listForUser returns empty for user with no roles

- GIVEN a user with no role assignments
- WHEN `listForUser(userId)` is called
- THEN result is `[]`

### Requirement: RbacRolePermissionRepository port

The system MUST expose an `RbacRolePermissionRepository` interface with:

| Method | Signature | Returns |
|--------|-----------|---------|
| `grant` | `(roleId: string, permissionId: string)` | `void` |
| `revoke` | `(roleId: string, permissionId: string)` | `void` |
| `listForRole` | `(roleId: string)` | `string[]` (permission IDs) |

Note: `listPermissionsForUser` and permission resolution across all a user's roles are implemented in `RbacUserRepository.listPermissionsForUser` via a single nested Prisma query — NOT in this port.

#### Scenario: grant is idempotent on duplicate

- GIVEN `(roleId, permissionId)` already granted
- WHEN `grant(roleId, permissionId)` is called again
- THEN no error is thrown (upsert or ignore-conflict semantics)

#### Scenario: listForRole returns empty for role with no permissions

- GIVEN a role with no `RbacRolePermission` rows
- WHEN `listForRole(roleId)` is called
- THEN result is `[]`

### Requirement: Domain boundary — no Prisma imports

All five port interfaces MUST live in `src/domain/ports/` and MUST NOT import from `@infrastructure/*`, `@prisma/client`, or any Node.js I/O module.

#### Scenario: tsc --noEmit passes with clean boundaries

- GIVEN port files import only from `@domain/*` or standard TS types
- WHEN `tsc --noEmit` is run
- THEN no boundary violations are reported
