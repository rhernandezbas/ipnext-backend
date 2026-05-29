# Spec — rbac-user-routes (SDD #2 · BE Capability 3)

**Change**: user-management-crud
**Layer**: Infrastructure — HTTP routes
**File**: `src/infrastructure/http/routes/rbacUser.routes.ts`
**Mount point**: `/admin/rbac/users` (in `src/infrastructure/http/app.ts`)

---

## Overview

A single Express router that exposes the 10 use cases over HTTP. This is the **first production
mount** of `requirePerm('admin', 'manage')` in the project — applied at the router level so
every route in this file is automatically protected.

---

## Route table

| Method | Path | Use case | Request body | Success |
|--------|------|----------|-------------|---------|
| `GET` | `/` | ListRbacUsers | — | `200 { users: RbacUserWithRolesDto[] }` |
| `GET` | `/:id` | GetRbacUser | — | `200 { user: RbacUserWithRolesDto }` |
| `POST` | `/` | CreateRbacUser | `{ name, email, login, password, roleIds }` | `201 { user: RbacUserWithRolesDto }` |
| `PATCH` | `/:id` | UpdateRbacUser | `{ name?, email?, login?, password?, status? }` | `200 { user: RbacUserDto }` |
| `DELETE` | `/:id` | DeleteRbacUser | — | `204` (no body) |
| `GET` | `/:id/roles` | ListRolesForUser | — | `200 { roles: RbacRoleDto[] }` |
| `PUT` | `/:id/roles` | SetRolesForUser | `{ roleIds: string[] }` | `200 { roles: RbacRoleDto[] }` |
| `POST` | `/:id/roles` | AssignRoleToUser | `{ roleId: string }` | `200 { role: RbacRoleDto }` |
| `DELETE` | `/:id/roles/:roleId` | RemoveRoleFromUser | — | `204` (no body) |
| `POST` | `/:id/password` | ChangeRbacUserPassword | `{ newPassword, oldPassword? }` | `204` (no body) |

---

## Authentication & authorization

```ts
router.use(requirePerm('admin', 'manage'));
```

Applied at router level (not per-route). All routes in this file require the authenticated user
to have `admin:manage` permission.

**First mount context**: `requirePerm` was defined and tested in SDD #1 but NOT mounted on any
production route until this SDD. Integration tests (see below) must exercise the middleware
explicitly to verify it gates correctly.

---

## DI factory

```ts
export interface RbacUserRouterDeps {
  listUsers: ListRbacUsers;
  getUser: GetRbacUser;
  createUser: CreateRbacUser;
  updateUser: UpdateRbacUser;
  deleteUser: DeleteRbacUser;
  changePassword: ChangeRbacUserPassword;
  listRolesForUser: ListRolesForUser;
  setRolesForUser: SetRolesForUser;
  assignRoleToUser: AssignRoleToUser;
  removeRoleFromUser: RemoveRoleFromUser;
}

export function createRbacUserRouter(deps: RbacUserRouterDeps): Router
```

Wired in `app.ts`:
```ts
app.use('/admin/rbac/users', requirePerm('admin', 'manage'), createRbacUserRouter(deps));
```

Note: `requirePerm` is also applied inside the router via `router.use(...)` as defense-in-depth.
The outer `app.use` placement ensures the middleware runs before the router is entered.

---

## Error mapping

Domain `DomainError` instances are caught by the global error handler (existing middleware).
The route layer itself does NOT catch errors — it re-throws to the global handler.

| Domain error code | HTTP status | Response body |
|-------------------|-------------|---------------|
| `USER_NOT_FOUND` | 404 | `{ error: { code: 'USER_NOT_FOUND', message: '...' } }` |
| `ROLE_NOT_FOUND` | 404 | `{ error: { code: 'ROLE_NOT_FOUND', message: '...' } }` |
| `LOGIN_ALREADY_TAKEN` | 409 | `{ error: { code: 'LOGIN_ALREADY_TAKEN', ... } }` |
| `EMAIL_ALREADY_TAKEN` | 409 | `{ error: { code: 'EMAIL_ALREADY_TAKEN', ... } }` |
| `PASSWORD_TOO_SHORT` | 400 | `{ error: { code: 'PASSWORD_TOO_SHORT', ... } }` |
| `AT_LEAST_ONE_ROLE_REQUIRED` | 400 | `{ error: { code: 'AT_LEAST_ONE_ROLE_REQUIRED', ... } }` |
| `CANNOT_DELETE_SELF` | 403 | `{ error: { code: 'CANNOT_DELETE_SELF', ... } }` |
| `CANNOT_REMOVE_LAST_SUPER_ADMIN` | 403 | `{ error: { code: 'CANNOT_REMOVE_LAST_SUPER_ADMIN', ... } }` |
| `INVALID_OLD_PASSWORD` | 403 | `{ error: { code: 'INVALID_OLD_PASSWORD', ... } }` |
| Generic `DomainError` | 400 | `{ error: { code: error.code, message: error.message } }` |
| `PERMISSION_DENIED` (requirePerm) | 403 | `{ error: { code: 'PERMISSION_DENIED', ... } }` |
| `NO_USER_CONTEXT` (requirePerm) | 401 | `{ error: { code: 'NO_USER_CONTEXT', ... } }` |

The global error handler already maps `DomainError.code` to HTTP status. If the mapping table
above introduces new codes with specific statuses (403 vs 400), the global handler's switch/map
must be updated to include them.

---

## `POST /:id/password` — admin vs self-change resolution

The route determines `isAdminManaged`:
```ts
// route handler
const requestingUserId = req.user.id;          // injected by auth middleware
const isAdminManaged = req.params.id !== requestingUserId;
await deps.changePassword.execute(req.params.id, req.body, isAdminManaged);
```

---

## Audit stub (SDD #4 TODO)

Each mutating route (POST, PATCH, DELETE, POST /password, PUT/:id/roles, POST/:id/roles, DELETE/:id/roles/:roleId) should emit an audit event. In SDD #2:

```ts
// TODO(SDD#4): replace with AuditService.emit(...)
console.log('[AUDIT]', { action, actorId: req.user.id, targetId, timestamp: new Date() });
```

The stub logs to console. SDD #4 will replace it with a proper `AuditRepository` port call.

---

## Requirements

- R-ROUTE-1 All 10 routes return correct success status codes (see route table).
- R-ROUTE-2 `requirePerm('admin', 'manage')` applied at router level — a user without `admin:manage` receives `403 PERMISSION_DENIED` on ALL routes.
- R-ROUTE-3 Unauthenticated request (no JWT / no `req.user`) receives `401 NO_USER_CONTEXT`.
- R-ROUTE-4 `DELETE /:id` passes `req.user.id` as `requestingUserId` to DeleteRbacUser.
- R-ROUTE-5 `POST /:id/password` resolves `isAdminManaged` from `req.params.id !== req.user.id`.
- R-ROUTE-6 Serialized responses NEVER contain `passwordHash` in any user object.
- R-ROUTE-7 Router is mounted at `/admin/rbac/users` in `app.ts` — all paths are absolute.
- R-ROUTE-8 `PATCH /:id` with empty body `{}` returns `200` with unchanged user (no-op update is valid).

---

## Scenarios (route integration tests via supertest)

**Setup**: supertest app with in-memory repos + `InMemoryPasswordHasher`. Auth middleware injected with a fixed `req.user` that has `admin:manage`.

WHEN `GET /admin/rbac/users` with valid auth  
THEN `200` with `{ users: [...] }` — no `passwordHash` in any user

WHEN `POST /admin/rbac/users` with valid body  
THEN `201` with `{ user: RbacUserWithRolesDto }`

WHEN `POST /admin/rbac/users` with `password: "short"`  
THEN `400` with `{ error: { code: "PASSWORD_TOO_SHORT" } }`

WHEN `POST /admin/rbac/users` with `roleIds: []`  
THEN `400` with `{ error: { code: "AT_LEAST_ONE_ROLE_REQUIRED" } }`

WHEN `GET /admin/rbac/users/:unknownId`  
THEN `404` with `{ error: { code: "USER_NOT_FOUND" } }`

WHEN `DELETE /admin/rbac/users/:id` where id === requesting user's id  
THEN `403` with `{ error: { code: "CANNOT_DELETE_SELF" } }`

WHEN `DELETE /admin/rbac/users/:id` where user is last super_admin  
THEN `403` with `{ error: { code: "CANNOT_REMOVE_LAST_SUPER_ADMIN" } }`

WHEN request has NO auth token (no `req.user`)  
THEN `401` with `{ error: { code: "NO_USER_CONTEXT" } }`

WHEN request has auth token but user lacks `admin:manage`  
THEN `403` with `{ error: { code: "PERMISSION_DENIED" } }`

WHEN `POST /admin/rbac/users/:id/password` where id === requesting user's id (self-change), body has no `oldPassword`  
THEN `403` with `{ error: { code: "INVALID_OLD_PASSWORD" } }`

WHEN `PATCH /admin/rbac/users/:id` with `{ }` (empty body)  
THEN `200` with user unchanged

---

## Test matrix

| Suite | File |
|-------|------|
| Route integration | `src/__tests__/infrastructure/http/routes/rbacUser.routes.test.ts` |

Tests use `supertest(app)` with the full Express app wired with in-memory repos.
The auth middleware is configured in test setup to inject a `req.user` fixture with `admin:manage`.
A second fixture without the permission tests the 403 path.
