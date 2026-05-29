# rbac-middleware Specification

## Purpose

Define the `requirePermission(module, action)` Express middleware factory. The middleware resolves the authenticated user's permissions per-request and gates access by returning 403 when the check fails. `super_admin` always bypasses the check.

## Requirements

### Requirement: requirePermission factory signature

The system MUST export a factory function `requirePermission(userRepo: RbacUserRepository, module: RbacModuleCode, action: PermissionAction): RequestHandler` from `src/infrastructure/http/middleware/requirePermission.ts`. The factory MUST accept an `RbacUserRepository` via closure or dependency injection — no direct Prisma import. (`RbacUserRepository` exposes both `listRolesForUser` and `listPermissionsForUser`, making it the single dependency needed for the full resolution chain.)

#### Scenario: Factory returns an Express RequestHandler

- GIVEN `requirePermission("clients", "read")` is called with a valid repo
- WHEN the return value is inspected
- THEN it is a function with signature `(req, res, next) => void`

### Requirement: Permission granted — next() called

The middleware MUST call `next()` when the resolved user has the requested `(module, action)` permission in any of their roles.

#### Scenario: User with matching permission passes through

- GIVEN `req.user = { id: "u1" }` is set by prior JWT middleware
- AND user `u1` has role `noc` which has permission `(network, read)`
- WHEN `requirePermission("network", "read")` middleware runs
- THEN `next()` is called and no response is sent

### Requirement: Permission denied — 403 returned

The middleware MUST return HTTP 403 with body `{ error: "FORBIDDEN", code: "PERMISSION_DENIED", module, action }` when the user does NOT have the requested permission.

#### Scenario: User without permission receives 403

- GIVEN `req.user = { id: "u2" }` is set
- AND user `u2` has role `ventas` which has no `(billing, write)` permission
- WHEN `requirePermission("billing", "write")` middleware runs
- THEN response is `403` with body `{ error: "FORBIDDEN", code: "PERMISSION_DENIED", module: "billing", action: "write" }`
- AND `next()` is NOT called

### Requirement: super_admin short-circuit

The middleware MUST call `next()` immediately — without querying permissions — when the resolved user holds the `super_admin` role. This MUST be the first check after user resolution.

#### Scenario: super_admin bypasses permission check

- GIVEN `req.user = { id: "sa1" }` and user `sa1` has role `super_admin`
- WHEN `requirePermission("settings", "delete")` middleware runs
- THEN `next()` is called without querying `RbacUserRepository.listPermissionsForUser`

### Requirement: Unauthenticated request — 401 returned

The middleware MUST return HTTP 401 with body `{ error: "UNAUTHORIZED", code: "NO_USER_CONTEXT" }` when `req.user` is absent or has no `id`.

#### Scenario: Missing req.user returns 401

- GIVEN `req.user` is `undefined`
- WHEN `requirePermission("clients", "read")` middleware runs
- THEN response is `401` with body `{ error: "UNAUTHORIZED", code: "NO_USER_CONTEXT" }`
- AND `next()` is NOT called

### Requirement: Per-request resolution — no in-process cache

For v1, the middleware MUST resolve permissions fresh on every request by calling `RbacUserRepository.listPermissionsForUser`. No in-memory caching is applied. Caching is deferred to SDD #5.

#### Scenario: Repository is called on every request

- GIVEN a valid user making two sequential requests to the same route
- WHEN both requests are processed
- THEN `listPermissionsForUser` is called exactly once per request (2 total calls)

### Requirement: Middleware does not import Prisma

The middleware file MUST NOT import from `@prisma/client` or any `@infrastructure/adapters/prisma/*` path. It depends only on the port interface.

#### Scenario: tsc --noEmit passes with clean boundary

- GIVEN `requirePermission.ts` imports only the `RbacUserRepository` interface from `@domain/ports/`
- WHEN `tsc --noEmit` is run
- THEN no boundary violations are reported
