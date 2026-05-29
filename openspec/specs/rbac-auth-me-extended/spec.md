# Spec: rbac-auth-me-extended

## Capability
HTTP change to `GET /api/auth/me` — additive response extension.

---

## Context

- Current: `GET /api/auth/me` returns `req.user` which is `{ id, login, email }` (JWT payload shape from SDD #2).
- This change extends the response to include `roles` and `permissions` without
  breaking existing FE code that reads `user.id`, `user.login`, `user.email`.
- `ResolveUserPermissions` (rbac-effective-permissions) must be implemented first.

---

## Request

```
GET /api/auth/me
Cookie: auth_token=<valid JWT>
```

## Response shape (200 OK)

```ts
{
  user: {
    id: string;        // UUID
    login: string;
    email: string;
    name: string;      // display name
  };
  roles: Array<{
    id: string;
    code: string;
    label: string;
  }>;
  permissions: string[];  // ["*"] for super_admin, flat code list otherwise
}
```

### Shape notes
- `user.name` is NEW. Previously the JWT only carried `{id, login, email}`.
  The route handler must fetch `name` from `RbacUserRepository` or include it
  in the JWT payload. Decision: fetch from DB at `/me` time (keeps JWT minimal).
- `roles` contains only `{ id, code, label }` — no isSystem, no createdAt.
  Prevents DTO leak.
- `permissions` comes verbatim from `ResolveUserPermissions.execute(userId)`.

---

## Caching headers

The response MUST include:
```
Cache-Control: private, max-age=0, must-revalidate
```

Rationale: FE React Query client caches with staleTime=5min. Browser MUST NOT
share across users (private) or serve stale on hard-reload (must-revalidate).

---

## Requirements

### R1 — auth middleware unchanged
The existing `authMiddleware` (JWT verification + `req.user = payload`) is not
modified. The `/me` route adds post-auth logic only.

### R2 — roles serialisation
Roles are fetched via `RbacUserRoleRepository.listForUser(userId)` to get
roleIds, then `RbacRoleRepository.findById` per id (or a listForUser-returning-
roles variant). Returned as `[{ id, code, label }]`.

**Port gap**: `RbacUserRoleRepository` currently returns `string[]` (role IDs).
The route needs full `RbacRole` objects. Options:
- A) Add `listRolesForUser(userId): Promise<RbacRole[]>` to
  `RbacUserRoleRepository` port (preferred — single query in Prisma).
- B) Fetch IDs + resolve each via `RbacRoleRepository.findById` (N+1).

**Decision**: Option A. Add `listRolesForUser` to `RbacUserRoleRepository` port.
Both InMemory and Prisma adapters must implement it.

### R3 — permissions via use case
`ResolveUserPermissions.execute(userId)` is called after roles fetch.
The route handler does NOT re-implement the union logic.

### R4 — unauthenticated → 401
Requests with no cookie or invalid JWT hit the existing `authMiddleware` and
return `401 UNAUTHORIZED` before reaching the handler.

### R5 — route handler must not throw unhandled exceptions
Wrap the DB calls in try/catch; on unexpected error return `500 INTERNAL_ERROR`.

---

## Scenarios (= test cases)

### S1 — super_admin
```
Given: authenticated as super_admin user
When:  GET /api/auth/me
Then:  200 OK
And:   body.permissions === ["*"]
And:   body.roles contains [{ id, code: "super_admin", label: "Super Administrador" }]
And:   body.user has { id, login, email, name }
And:   Cache-Control header = "private, max-age=0, must-revalidate"
```

### S2 — regular user with assigned roles
```
Given: user "tecnico1" has role "tecnico" with [scheduling.read, scheduling.write]
When:  GET /api/auth/me
Then:  200 OK
And:   body.permissions = ["scheduling.read", "scheduling.write"] (any order)
And:   body.roles = [{ id, code: "tecnico", label: "Técnico" }]
```

### S3 — user with no roles
```
Given: authenticated user has no assigned roles
When:  GET /api/auth/me
Then:  200 OK
And:   body.roles = []
And:   body.permissions = []
```

### S4 — unauthenticated
```
Given: no auth cookie (or invalid JWT)
When:  GET /api/auth/me
Then:  401 { error: "UNAUTHORIZED", code: "NO_USER_CONTEXT" }
```

### S5 — user with multiple roles (union)
```
Given: user has roles ["noc", "tecnico"]
  noc: [monitoring.read]
  tecnico: [scheduling.read, scheduling.delete]
When:  GET /api/auth/me
Then:  200 OK
And:   body.permissions contains exactly
       ["monitoring.read", "scheduling.read", "scheduling.delete"] (any order)
And:   body.roles has 2 elements
```

---

## Port changes (required as part of this capability)

```ts
// RbacUserRoleRepository — add method:
listRolesForUser(userId: string): Promise<RbacRole[]>;
```

Both adapters must implement it:
- `InMemoryRbacUserRoleRepository`: filter assignments + join via `InMemoryRbacRoleRepository`
- `PrismaRbacUserRoleRepository`: `prisma.rbacUserRole.findMany({ where: { userId }, include: { role: true } })`

---

## Implementation notes

- Route file: `src/infrastructure/http/routes/auth.routes.ts`
- Factory function `createAuthRouter` must accept `ResolveUserPermissions` use
  case + `RbacUserRoleRepository` as new constructor params.
- DI wiring in `src/infrastructure/http/app.ts`.
- Test file: `src/__tests__/infrastructure/http/routes/auth.me.test.ts`
  using supertest + InMemory repos.
