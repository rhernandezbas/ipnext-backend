# Tasks — user-management-crud (SDD #2)

**Status**: ready  
**Repos**: `ipnext-backend` + `ipnext-frontend`  
**Strict TDD**: ACTIVE — every implementation task is preceded by a failing-test task. RED → GREEN → REFACTOR.  
**BE test runner**: `npm test`  
**FE test runner**: `npx vitest run`

---

## Phase 1 — BE: Domain Port & Password Hashing (no DB, no Express)

### 1.1 [RED] PasswordHasher contract tests

- [x] Create `src/__tests__/infrastructure/adapters/_shared/passwordHasherContractTests.ts` with a `runPasswordHasherContractTests(makeHasher)` function
- [x] Write test: `hash(x)` returns a non-empty string that is NOT equal to `x` (no plaintext leak)
- [x] Write test: `verify(x, hash(x))` resolves `true`
- [x] Write test: `verify('wrong', hash(x))` resolves `false`
- [x] Write test: `verify(x, 'malformed-string')` resolves `false` and does NOT throw
- [x] Write test runner file `src/__tests__/infrastructure/adapters/in-memory/InMemoryPasswordHasher.contract.test.ts` that calls the shared suite — confirm it FAILS (no impl yet)

### 1.2 [GREEN] PasswordHasher port + adapters

- [x] Create `src/domain/ports/PasswordHasher.ts` with interface `{ hash(plain: string): Promise<string>; compare(plain: string, hash: string): Promise<boolean> }`
  - Note: spec uses `compare`, design uses `verify` — use `compare` (matches spec, which takes precedence)
- [x] Create `src/infrastructure/adapters/in-memory/InMemoryPasswordHasher.ts` — prefix strategy: `hash = "hashed::${plain}"`, `compare = (hash === "hashed::" + plain)`
- [x] Create `src/infrastructure/adapters/bcrypt/BcryptPasswordHasher.ts` — uses `bcryptjs` cost 10, `try/catch` in compare (returns `false` on malformed hash, never throws)
- [x] Update `src/__tests__/infrastructure/adapters/in-memory/InMemoryPasswordHasher.contract.test.ts` to confirm all contract tests pass
- [x] Create `src/__tests__/infrastructure/adapters/bcrypt/BcryptPasswordHasher.contract.test.ts` running the same suite against `BcryptPasswordHasher` — confirm green

### 1.3 [RED + GREEN] RbacUserRepository port extensions (contract tests first)

- [x] Add to `src/__tests__/infrastructure/adapters/_shared/rbacUserContractTests.ts`:
  - Test: `list()` returns empty array when no users exist
  - Test: `list()` returns all users (create 2, assert count = 2; no `passwordHash` in results)
  - Test: `update(id, { name: 'New' })` updates only `name`, other fields unchanged
  - Test: `update(id, { passwordHash: 'newhash' })` stores new passwordHash (verify via `findByLogin`)
  - Test: `update` with non-existent id throws a domain-identifiable error (or rejects)
  - Test: `delete(id)` causes subsequent `findById(id)` to return `null`
  - Test: `countUsersWithRoleCode('super_admin')` returns 0 when no users have that role
  - Test: `countUsersWithRoleCode('super_admin')` returns correct count after seeding (requires `RbacUserRoleRepository` sibling seeded)
- [x] Confirm tests FAIL before implementation

- [x] Extend `RbacUserRepository` interface in `src/domain/ports/RbacUserRepository.ts` with:
  - `list(): Promise<RbacUser[]>`
  - `update(id: string, patch: { name?: string; email?: string; login?: string; status?: 'active' | 'disabled'; passwordHash?: string }): Promise<RbacUser>`
  - `delete(id: string): Promise<void>`
  - `countUsersWithRoleCode(roleCode: string): Promise<number>`
- [x] Extend `InMemoryRbacUserRepository` with the 4 new methods (in-memory impl — O(n) lookups acceptable)
- [x] Extend `PrismaRbacUserRepository` with the 4 new methods
  - For `delete`: check SDD #1 migration — if `ON DELETE CASCADE` is present on `RbacUserRole.userId`, a single `prisma.rbacUser.delete` suffices; otherwise use `$transaction([deleteMany pivot, delete user])`
  - For `countUsersWithRoleCode`: JOIN `RbacUserRole` + `RbacRole` via Prisma `include` or raw `count`
- [x] Confirm all contract tests pass for both InMemory and Prisma adapters (Prisma gated by `DATABASE_URL_TEST`)

---

## Phase 2 — BE: Domain Errors + DTOs

### 2.1 [GREEN] Domain errors file

- [x] Create `src/domain/errors/rbacUser.errors.ts` with typed `DomainError` subclasses:
  - `UserNotFoundError` — code `USER_NOT_FOUND`
  - `LoginAlreadyTakenError` — code `LOGIN_ALREADY_TAKEN`
  - `EmailAlreadyTakenError` — code `EMAIL_ALREADY_TAKEN`
  - `RoleNotFoundError` — code `ROLE_NOT_FOUND`
  - `AtLeastOneRoleRequiredError` — code `AT_LEAST_ONE_ROLE_REQUIRED`
  - `PasswordTooShortError` — code `PASSWORD_TOO_SHORT`
  - `CannotDeleteSelfError` — code `CANNOT_DELETE_SELF`
  - `CannotRemoveLastSuperAdminError` — code `CANNOT_REMOVE_LAST_SUPER_ADMIN`
  - `InvalidOldPasswordError` — code `INVALID_OLD_PASSWORD`
  - Verify all extend the existing `DomainError` base class (check `src/domain/errors/`)

### 2.2 [GREEN] DTOs

- [x] Create `src/application/dto/rbacUser.dto.ts` with:
  - `RbacRoleDto`, `RbacUserDto` (NO `passwordHash` field), `RbacUserWithRolesDto`
  - `CreateRbacUserDto`, `UpdateRbacUserDto` (includes optional `login` and optional `password`), `ChangeRbacUserPasswordDto` (fields: `newPassword`, `oldPassword?`)
  - Mappers: `toRbacUserDto(entity)`, `toRbacRoleDto(entity)`, `toRbacUserWithRolesDto(entity, roles[])`
  - Compile-time check: add a `_noPasswordHash: never` type assertion or simply verify `passwordHash` is not in `RbacUserDto`
- [x] Write a snapshot/type test in `src/__tests__/application/dto/rbacUser.dto.test.ts`:
  - Assert `toRbacUserDto(...)` result JSON serialization does NOT contain key `"passwordHash"`

---

## Phase 3 — BE: Use Cases CRUD (TDD per use case)

### 3.1 [RED] ListRbacUsers test

- [x] Create `src/__tests__/application/rbac/ListRbacUsers.test.ts` with tests:
  - Empty repo → returns `[]`
  - 2 users with roles seeded → returns array of 2 `RbacUserWithRolesDto` with correct `roles[]`
  - No `passwordHash` in any DTO (JSON serialization check)

### 3.2 [GREEN] ListRbacUsers implementation

- [x] Create `src/application/use-cases/rbac/ListRbacUsers.ts`
  - Constructor: `(users: RbacUserRepository, userRoles: RbacUserRoleRepository, roles: RbacRoleRepository)`
  - `execute(): Promise<RbacUserWithRolesDto[]>` — fetches all users, resolves roles for each, maps to DTO

### 3.3 [RED] GetRbacUser test

- [x] Create `src/__tests__/application/rbac/GetRbacUser.test.ts` with tests:
  - Existing id → returns `RbacUserWithRolesDto` with correct fields
  - Non-existent id → throws `UserNotFoundError`
  - No `passwordHash` in output

### 3.4 [GREEN] GetRbacUser implementation

- [x] Create `src/application/use-cases/rbac/GetRbacUser.ts`
  - Constructor: `(users: RbacUserRepository, userRoles: RbacUserRoleRepository, roles: RbacRoleRepository)`
  - `execute(id: string): Promise<RbacUserWithRolesDto>`

### 3.5 [RED] CreateRbacUser test

- [x] Create `src/__tests__/application/rbac/CreateRbacUser.test.ts` with tests:
  - Happy path: user created, roles assigned, DTO returned with roles
  - `password` < 8 chars → throws `PasswordTooShortError`
  - `roleIds = []` → throws `AtLeastOneRoleRequiredError`
  - Unknown `roleId` → throws `RoleNotFoundError`
  - Duplicate `login` → throws `LoginAlreadyTakenError`
  - Duplicate `email` → throws `EmailAlreadyTakenError`
  - Stored hash equals `InMemoryPasswordHasher.hash(password)` — assert via `findByLogin`
  - No `passwordHash` in returned DTO

### 3.6 [GREEN] CreateRbacUser implementation

- [x] Create `src/application/use-cases/rbac/CreateRbacUser.ts`
  - Constructor: `(users: RbacUserRepository, roles: RbacRoleRepository, userRoles: RbacUserRoleRepository, hasher: PasswordHasher)`
  - Validation order (per spec): password length → roleIds length → each roleId exists → login unique → email unique → hash → create → assign roles → return DTO

### 3.7 [RED] UpdateRbacUser test

- [x] Create `src/__tests__/application/rbac/UpdateRbacUser.test.ts` with tests:
  - Partial patch (name only) → only name changed, rest unchanged
  - `password = ""` → passwordHash NOT changed
  - `password = "newpass1"` (≥8 chars) → passwordHash updated
  - `password = "short"` (5 chars) → throws `PasswordTooShortError`
  - Duplicate login → throws `LoginAlreadyTakenError`
  - Non-existent id → throws `UserNotFoundError`

### 3.8 [GREEN] UpdateRbacUser implementation

- [x] Create `src/application/use-cases/rbac/UpdateRbacUser.ts`
  - Constructor: `(users: RbacUserRepository, hasher: PasswordHasher)`
  - `execute(id: string, dto: UpdateRbacUserDto): Promise<RbacUserDto>`
  - Password: absent or `''` → skip; non-empty → validate length → hash → include in patch

### 3.9 [RED] DeleteRbacUser test

- [x] Create `src/__tests__/application/rbac/DeleteRbacUser.test.ts` with tests:
  - Non-self, non-last-super_admin → deleted (findById returns null after)
  - `id === requestingUserId` → throws `CannotDeleteSelfError`
  - Sole super_admin user → throws `CannotRemoveLastSuperAdminError`
  - One of 2 super_admin users → deletion succeeds
  - Non-existent id → throws `UserNotFoundError`

### 3.10 [GREEN] DeleteRbacUser implementation

- [x] Create `src/application/use-cases/rbac/DeleteRbacUser.ts`
  - Constructor: `(users: RbacUserRepository, userRoles: RbacUserRoleRepository)`
  - `execute(id: string, requestingUserId: string): Promise<void>`
  - Guard order (per spec): self-check → findById → count super_admins if applicable → delete

### 3.11 [RED] ChangeRbacUserPassword test

- [x] Create `src/__tests__/application/rbac/ChangeRbacUserPassword.test.ts` with tests:
  - Admin-managed (`isAdminManaged=true`): valid new password → hash updated, no old password check
  - Self-change (`isAdminManaged=false`) with correct `oldPassword` → hash updated
  - Self-change with wrong `oldPassword` → throws `InvalidOldPasswordError`
  - Self-change without `oldPassword` → throws `InvalidOldPasswordError`
  - `newPassword` < 8 chars → throws `PasswordTooShortError`
  - Non-existent user → throws `UserNotFoundError`

### 3.12 [GREEN] ChangeRbacUserPassword implementation

- [x] Create `src/application/use-cases/rbac/ChangeRbacUserPassword.ts`
  - Constructor: `(users: RbacUserRepository, hasher: PasswordHasher)`
  - `execute(targetId: string, dto: ChangeRbacUserPasswordDto, isAdminManaged: boolean): Promise<void>`

---

## Phase 4 — BE: Use Cases Roles (TDD per use case)

### 4.1 [RED] ListRolesForUser test

- [x] Create `src/__tests__/application/rbac/ListRolesForUser.test.ts` with tests:
  - User with 2 roles → returns 2 `RbacRoleDto` with correct fields
  - User with 0 roles → returns `[]`
  - Non-existent userId → throws `UserNotFoundError`

### 4.2 [GREEN] ListRolesForUser implementation

- [x] Create `src/application/use-cases/rbac/ListRolesForUser.ts`
  - Constructor: `(users: RbacUserRepository, userRoles: RbacUserRoleRepository, roles: RbacRoleRepository)`
  - `execute(userId: string): Promise<RbacRoleDto[]>`

### 4.3 [RED] AssignRoleToUser test

- [x] Create `src/__tests__/application/rbac/AssignRoleToUser.test.ts` with tests:
  - Both exist → `assign` called, returns void
  - Called twice with same args → no error (idempotent)
  - Non-existent userId → throws `UserNotFoundError`
  - Non-existent roleId → throws `RoleNotFoundError`

### 4.4 [GREEN] AssignRoleToUser implementation

- [x] Create `src/application/use-cases/rbac/AssignRoleToUser.ts`
  - Constructor: `(users: RbacUserRepository, roles: RbacRoleRepository, userRoles: RbacUserRoleRepository)`
  - `execute(userId: string, roleId: string): Promise<void>`

### 4.5 [RED] RemoveRoleFromUser test

- [x] Create `src/__tests__/application/rbac/RemoveRoleFromUser.test.ts` with tests:
  - Non-super_admin role → revoked
  - Sole super_admin with that role → throws `CannotRemoveLastSuperAdminError`
  - One of 2 super_admins → revoke succeeds
  - Role not assigned to user → no error (idempotent)
  - Non-existent userId → throws `UserNotFoundError`
  - Non-existent roleId → throws `RoleNotFoundError`

### 4.6 [GREEN] RemoveRoleFromUser implementation

- [x] Create `src/application/use-cases/rbac/RemoveRoleFromUser.ts`
  - Constructor: `(users: RbacUserRepository, roles: RbacRoleRepository, userRoles: RbacUserRoleRepository)`
  - `execute(userId: string, roleId: string): Promise<void>`

### 4.7 [RED] SetRolesForUser test

- [x] Create `src/__tests__/application/rbac/SetRolesForUser.test.ts` with tests:
  - User has [A, B], new set [B, C] → A revoked, C assigned, B unchanged; returned DTOs = [B, C]
  - Last super_admin + new set has no super_admin → throws `CannotRemoveLastSuperAdminError`
  - One of 2 super_admins + new set removes super_admin → succeeds
  - Non-existent roleId in new set → throws `RoleNotFoundError`
  - Idempotent repeat (same roleIds twice) → second call returns same DTOs, no extra side-effects
  - Non-existent userId → throws `UserNotFoundError`

### 4.8 [GREEN] SetRolesForUser implementation

- [x] Create `src/application/use-cases/rbac/SetRolesForUser.ts`
  - Constructor: `(users: RbacUserRepository, roles: RbacRoleRepository, userRoles: RbacUserRoleRepository)`
  - `execute(userId: string, roleIds: string[]): Promise<RbacRoleDto[]>`
  - Diff algorithm: load current → compute toAdd/toRemove → last-super_admin guard → apply delta → return DTOs
  - Document concurrency known limitation in a comment (last-write-wins — see spec R10.6)

---

## Phase 5 — BE: Auth Login Rewrite (LoginRbacUser + JWT + /auth/login)

### 5.1 [RED] LoginRbacUser use case test

- [x] Create `src/__tests__/application/rbac/LoginRbacUser.test.ts` with tests:
  - Happy path: valid login + matching password → returns `{ id, email, login }` shape
  - Unknown login → throws `AuthenticationError` (or `InvalidCredentialsError`)
  - Wrong password → throws `AuthenticationError`
  - Disabled user (`status: 'disabled'`) → throws `AuthenticationError`
  - After successful login, `updateLastLogin` called (assert via spy or check `findById().lastLoginAt`)

### 5.2 [GREEN] LoginRbacUser use case

- [x] Create `src/application/use-cases/rbac/LoginRbacUser.ts`
  - Constructor: `(users: RbacUserRepository, hasher: PasswordHasher)`
  - `execute(credentials: { login: string; password: string }): Promise<{ id: string; email: string; login: string; name: string }>`
  - Logic: `findByLogin(login)` → null or disabled → throw `AuthenticationError`; `hasher.compare(password, user.passwordHash)` → false → throw; `updateLastLogin(id, now)`; return safe fields

### 5.3 [RED] JwtAuthAdapter rewrite test

- [x] Create (or extend) `src/__tests__/infrastructure/adapters/jwt/JwtAuthAdapter.test.ts` with tests:
  - `login({ login, password })` with valid RbacUser → signed JWT contains `{ id: rbacUser.id, email, login }` (decode without verify to inspect payload)
  - `login` with unknown login → throws `AuthenticationError`
  - `getSession(validToken)` → returns `User` with `id` matching the rbacUser's id
  - `logout()` → returns cookie options with `maxAge: 0`

### 5.4 [GREEN] JwtAuthAdapter rewrite

- [x] Rewrite `src/infrastructure/adapters/jwt/JwtAuthAdapter.ts`:
  - Remove all `prisma.admin.*` usage
  - Use `LoginRbacUser` use case (injected via constructor)
  - Sign JWT with `{ id: rbacUser.id, email: rbacUser.email, login: rbacUser.login }`
  - `getSession`: decode and return `User` with `id` (now always an RbacUser.id)
  - Update `JwtPayload` interface to match the new shape

### 5.5 Update User entity

- [x] Update `src/domain/entities/auth.ts` — modify `User` interface:
  - Keep `id`, `username` (= `login`), `email`
  - `role` kept as optional `role?: string` for backwards compatibility with existing callers
  - `requirePermission` middleware reads `req.user.id` — correct since `id` is now an `RbacUser.id`

### 5.6 [RED] /auth/login route test (supertest)

- [x] Create `src/__tests__/infrastructure/auth.routes.test.ts`:
  - POST `/auth/login` with valid RbacUser credentials → `200`, cookie set, response body has `user` (no `passwordHash`)
  - POST `/auth/login` with unknown login → `401`
  - POST `/auth/login` with wrong password → `401`
  - POST `/auth/login` with disabled user → `401` (no status leak)
  - POST `/auth/login` missing body fields → `400`
  - POST `/auth/logout` → `200`, cookie cleared
  - GET `/auth/me` with valid cookie → `200`
  - Wired with `InMemoryRbacUserRepository` + `InMemoryPasswordHasher`

### 5.7 [GREEN] auth.routes.ts rewrite

- [x] `src/infrastructure/http/routes/auth.routes.ts` — no source changes needed: the route already calls `authProvider.login(...)` which now delegates to `LoginRbacUser`. Legacy code was in the adapter, not the route handler. Route is 100% RbacUser via the updated JwtAuthAdapter.
- [x] `src/infrastructure/http/app.ts` — updated `new JwtAuthAdapter(loginRbacUser)` replacing `new JwtAuthAdapter()`. Added `BcryptPasswordHasher` and `LoginRbacUser` singletons.
- [x] `src/domain/entities/auth.ts` — `role` field made optional to not break existing callers.

### 5.8 [RED] Verify no legacy admin tests break suite

- [x] Ran `npm test` — 1351 passing, 0 failing, 71 skipped (Prisma DB)
- [x] `authMiddleware.test.ts` — still passes, `role: 'admin'` in mockUser is now optional property (backward compatible)
- [x] No tests deleted — the legacy admin test file (`authMiddleware.test.ts`) tests generic auth middleware behavior, not Admin-specific login. Fully compatible with new User shape.
- [x] Full test suite green.

---

## Phase 6 — BE: HTTP Routes for /admin/rbac/users

### 6.1 Check global error handler

- [x] Read `src/infrastructure/http/app.ts` (or the error handler middleware) — confirm `DomainError` mapping includes the new codes added in Phase 2: `USER_NOT_FOUND`, `ROLE_NOT_FOUND`, `LOGIN_ALREADY_TAKEN`, `EMAIL_ALREADY_TAKEN`, `PASSWORD_TOO_SHORT`, `AT_LEAST_ONE_ROLE_REQUIRED`, `CANNOT_DELETE_SELF`, `CANNOT_REMOVE_LAST_SUPER_ADMIN`, `INVALID_OLD_PASSWORD`
- [x] Update the global error handler to add any missing code → HTTP status mappings (per spec error table in rbac-user-routes/spec.md)

### 6.2 [RED] Route integration tests (supertest)

- [x] Create `src/__tests__/infrastructure/http/routes/rbacUser.routes.test.ts` with test suite using supertest + InMemory repos:
  - Setup: wire full app with `InMemoryRbacUserRepository`, `InMemoryRbacRoleRepository`, `InMemoryRbacUserRoleRepository`, `InMemoryPasswordHasher`; inject auth middleware with a seeded super_admin fixture in `req.user`
  - `GET /admin/rbac/users` with valid auth → `200 { users: [...] }`, no `passwordHash` in any user object
  - `POST /admin/rbac/users` with valid body → `201 { user: RbacUserWithRolesDto }`
  - `POST /admin/rbac/users` with `password: "short"` → `400` + `code: "PASSWORD_TOO_SHORT"`
  - `POST /admin/rbac/users` with `roleIds: []` → `400` + `code: "AT_LEAST_ONE_ROLE_REQUIRED"`
  - `GET /admin/rbac/users/:unknownId` → `404` + `code: "USER_NOT_FOUND"`
  - `PATCH /admin/rbac/users/:id` with `{}` empty body → `200` with user unchanged
  - `DELETE /admin/rbac/users/:id` where id === `req.user.id` → `403` + `code: "CANNOT_DELETE_SELF"`
  - `DELETE /admin/rbac/users/:id` where user is last super_admin → `403` + `code: "CANNOT_REMOVE_LAST_SUPER_ADMIN"`
  - `POST /admin/rbac/users/:id/password` (self-change, no `oldPassword`) → `403` + `code: "INVALID_OLD_PASSWORD"`
  - `PUT /admin/rbac/users/:id/roles` with `{ roleIds: [validId] }` → `200 { roles: [...] }`
  - No auth token (no cookie) → `401` + `code: "NO_USER_CONTEXT"`
  - Auth token but user lacks `admin:manage` → `403` + `code: "PERMISSION_DENIED"`
  - Security snapshot: `GET /admin/rbac/users` response body — assert `JSON.stringify` does NOT contain `"passwordHash"`

### 6.3 [GREEN] rbacUser.routes.ts router implementation

- [x] Create `src/infrastructure/http/routes/rbacUser.routes.ts` with `createRbacUserRouter(deps: RbacUserRouterDeps): Router`
  - All 10 routes (per spec route table)
  - `DELETE /:id` handler passes `req.user!.id` as `requestingUserId`
  - `POST /:id/password` handler resolves `isAdminManaged = (req.params.id !== req.user!.id)`
  - Audit stub `console.log('[AUDIT]', ...)` on each mutating route (TODO SDD#4 comment)
  - All responses map through `toRbacUserDto` / `toRbacRoleDto` — never serialize entity directly

### 6.4 [GREEN] GET /admin/rbac/roles endpoint

- [x] Add inline `rbacRolesRouter` in `app.ts` for `GET /admin/rbac/roles` → `rbacRoleRepo.listAll().map(toRbacRoleDto)` with the same auth + permission guards (needed by FE role multi-select)

### 6.5 DI wiring in app.ts

- [x] Add to `src/infrastructure/http/app.ts`:
  - Import `BcryptPasswordHasher` and instantiate `const passwordHasher = new BcryptPasswordHasher()` (module-level singleton, next to existing RBAC singletons)
  - Import all 10 use cases from `@application/use-cases/rbac/`
  - Import and instantiate `LoginRbacUser` (for auth rewrite wiring)
  - Instantiate all 10 CRUD use cases inside `createApp()` (RBAC user management block)
  - Mount `createRbacUserRouter(deps)` at `/admin/rbac/users`
  - Mount `rbacRolesRouter` at `/admin/rbac/roles`
  - Wire updated `JwtAuthAdapter` with `rbacUserRepo` + `passwordHasher` (replacing Prisma-direct adapter)

---

## Phase 7 — BE: Bootstrap Script

### 7.1 [RED] bootstrapRbac unit tests

- [x] Create `src/__tests__/infrastructure/bootstrap/bootstrapRbac.test.ts` with tests:
  - Missing any env var → `{ outcome: 'skipped', reason: 'envs-missing' }`, no repo writes
  - All envs present, login already exists → `{ outcome: 'skipped', reason: 'user-already-exists' }`, no repo writes
  - All envs present, another user already has super_admin role → `{ outcome: 'skipped', reason: 'super_admin-already-assigned' }`, no repo writes
  - All envs present, clean state → `{ outcome: 'created', login: env.login }`, user in repo with `passwordHash === env.passwordHash` verbatim (NOT re-hashed)
  - super_admin role missing from roleRepo → throws `Error` containing `'super_admin role not found'`
  - (Optional 5th) Missing only `BOOTSTRAP_RBAC_PASSWORD_HASH` → skipped, other envs irrelevant

### 7.2 [GREEN] bootstrapRbac implementation

- [x] Create `src/infrastructure/bootstrap/bootstrapRbac.ts` with:
  - Exported `bootstrapRbac(userRepo, roleRepo, userRoleRepo, env: BootstrapEnv): Promise<BootstrapResult>`
  - Algorithm per spec rbac-bootstrap/spec.md (5 steps: envs check → login exists? → super_admin assigned? → find role → create user + assign)
  - `main()` function that reads `process.env`, calls `bootstrapRbac`, logs `[bootstrap-rbac] ...`, exits 0
  - Logging contract per spec (exact log prefixes)

### 7.3 npm script + deploy step

- [x] Add to `package.json` scripts: `"bootstrap-rbac": "node dist/infrastructure/bootstrap/bootstrapRbac.js"` (compiled path — ts-node is devDependency, not in production image)
- [x] Verify `src/infrastructure/bootstrap/` is covered by `tsconfig.json` `include` (confirmed: `"include": ["src/**/*"]` covers it — no change needed)
- [x] Add step to `.github/workflows/deploy.yml` AFTER the `Run DB migrations` step and BEFORE `Deploy container` (docker run matching migrations step format, `node dist/...` inside container)
- [x] Document GitHub secrets TODO in a code comment at the top of `bootstrapRbac.ts`: operator must set `BOOTSTRAP_RBAC_LOGIN`, `BOOTSTRAP_RBAC_EMAIL`, `BOOTSTRAP_RBAC_NAME`, `BOOTSTRAP_RBAC_PASSWORD_HASH` in EasyPanel secrets BEFORE the first push

---

## Phase 8 — BE: Quality Gates

### 8.1 Full suite green

- [ ] Run `npm test` — all tests pass (0 failures); note count for reference
- [ ] Fix any test failures introduced by the `JwtAuthAdapter` rewrite (Phase 5): examine `src/__tests__/infrastructure/authMiddleware.test.ts` and legacy admin route tests — update or remove tests that exclusively tested the removed legacy Admin login path
- [ ] Run `npm test` again — confirm green

### 8.2 TypeScript clean

- [ ] Run `npx tsc --noEmit` — 0 errors
- [ ] Fix any type errors (path aliases, missing imports, wrong return types)
- [ ] Confirm `npx tsc --noEmit` exits cleanly

### 8.3 BE commit checkpoint

- [ ] Draft conventional commit message (user controls the actual commit):
  ```
  feat(rbac): user management CRUD + roles + login rewrite + bootstrap script
  ```
  Scope includes: PasswordHasher port + adapters, 10 use cases, JwtAuthAdapter rewrite, LoginRbacUser, auth.routes.ts rewrite, rbacUser.routes.ts + rbacRoles endpoint, bootstrapRbac script, deploy.yml step, full test coverage.

---

## Phase 9 — FE: Types, API, and Hooks

### 9.1 Verify zod presence

- [ ] Check `package.json` in `ipnext-frontend` for `"zod"` dependency
  - If present: plan to use `@hookform/resolvers/zod` for form validation in Phase 10
  - If absent: use plain `react-hook-form` `register({ validate: ... })` pattern — note this decision for apply phase

### 9.2 [RED] API file tests

- [ ] Create `src/__tests__/api/rbacUsers.api.test.ts` with tests (vi.mock `./axios-client`):
  - `rbacUsersApi.list()` calls `GET /admin/rbac/users` and unwraps `.users`
  - `rbacUsersApi.get(id)` calls `GET /admin/rbac/users/:id` and unwraps `.user`
  - `rbacUsersApi.create(payload)` calls `POST /admin/rbac/users` and unwraps `.user`
  - `rbacUsersApi.update(id, patch)` calls `PATCH /admin/rbac/users/:id`
  - `rbacUsersApi.delete(id)` calls `DELETE /admin/rbac/users/:id`, returns `void`
  - `rbacUsersApi.setRoles(id, roleIds)` calls `PUT /admin/rbac/users/:id/roles` and unwraps `.roles`
  - `rbacUsersApi.changePassword(id, body)` calls `POST /admin/rbac/users/:id/password`, returns `void`
- [ ] Create `src/__tests__/api/rbacRoles.api.test.ts`:
  - `rbacRolesApi.list()` calls `GET /admin/rbac/roles` and unwraps `.roles`

### 9.3 [GREEN] API file implementations

- [ ] Create `src/api/rbacUsers.api.ts` per spec (B.2 in design) — use `axiosClient` from `@/api/axios-client`
- [ ] Create `src/api/rbacRoles.api.ts` per spec — `GET /admin/rbac/roles`

### 9.4 Types

- [ ] Create `src/types/rbacRole.ts` with `RbacRoleDto`
- [ ] Create `src/types/rbacUser.ts` with `RbacUserDto`, `RbacUserWithRolesDto`, `CreateRbacUserPayload`, `UpdateRbacUserPayload`
  - Note: spec FE uses `Payload` suffix vs design's `Input` suffix — use `Payload` for consistency with the engram FE spec (#347)

### 9.5 [RED] Hook tests

- [ ] Create `src/__tests__/hooks/useRbacUsers.test.ts` (vi.mock `@/api/rbacUsers.api`):
  - `useRbacUsers()` fires `rbacUsersApi.list`, returns data
  - `useCreateRbacUser().mutateAsync(payload)` calls `rbacUsersApi.create` and invalidates `['rbac', 'users']`
  - `useUpdateRbacUser()` calls `rbacUsersApi.update` and invalidates list + detail keys
  - `useDeleteRbacUser()` calls `rbacUsersApi.delete` and invalidates list key
  - `useSetUserRoles(userId)` calls `rbacUsersApi.setRoles` and invalidates list + detail
- [ ] Create `src/__tests__/hooks/useRbacRoles.test.ts`:
  - `useRbacRoles()` fires `rbacRolesApi.list`, returns data

### 9.6 [GREEN] Hook implementations

- [ ] Create `src/hooks/useRbacUsers.ts` with all hooks per design B.3 (query keys: `['rbac', 'users']`, `['rbac', 'users', id]`)
- [ ] Create `src/hooks/useRbacRoles.ts` with `useRbacRoles()` (staleTime: 300_000 — roles change rarely)

### 9.7 Role labels constant

- [ ] Create `src/constants/rbacRoleLabels.ts` with `RBAC_ROLE_LABELS` dict per spec FE and design B.4:
  - `super_admin`, `administrador`, `administracion`, `ventas`, `noc`, `tecnico` → Spanish display labels
  - Export helper `getRoleLabel(role: RbacRoleDto): string`

---

## Phase 10 — FE: RbacUserModal Component

### 10.1 [RED] RbacUserModal tests

- [ ] Create `src/__tests__/pages/system/admin/RbacUserModal.test.tsx` with tests (hooks mocked via `vi.mock`):
  - Create mode: all required fields empty → submit disabled
  - Create mode: fill all fields, submit → `mutateAsync` called with correct payload
  - Create mode: password < 8 chars → inline error shown, submit NOT called
  - Create mode: password mismatch → inline error shown, submit NOT called
  - Create mode: 0 roles selected → validation error "Seleccioná al menos un rol", submit NOT called
  - Edit mode: form pre-filled with `initialValues` (name, email, login)
  - Edit mode: login field is disabled (cannot be changed)
  - Edit mode: password section collapsed by default (fields not visible)
  - Edit mode: toggle "Cambiar contraseña" → password fields appear
  - Edit mode: submit without touching password → payload does NOT contain `password` key
  - Edit mode: roleIds unchanged from initial → `setRoles` mutation NOT called
  - Edit mode: roleIds changed → `setRoles` mutation called with new ids
  - Server error `LOGIN_ALREADY_TAKEN` → inline error shown near login field + banner
  - Server error `EMAIL_ALREADY_TAKEN` → inline error shown near email field + banner
  - Server error `AT_LEAST_ONE_ROLE_REQUIRED` → banner shown
  - Server error `CANNOT_REMOVE_LAST_SUPER_ADMIN` → banner shown
  - Pressing Escape → `onClose` called
  - Focus trap: first text field receives focus on mount

### 10.2 [GREEN] RbacUserModal implementation

- [ ] Create `src/pages/system/admin/RbacUserModal.tsx` with:
  - Props: `{ mode: 'create' | 'edit'; initialValues?: RbacUserWithRolesDto; onClose: () => void; onSave: () => void; loading: boolean }`
  - `react-hook-form` with `mode: 'onBlur'`
  - Sticky header (per AD-FE-6 and FE convention)
  - Password section collapsed in edit mode behind "Cambiar contraseña" checkbox toggle (AD-FE-11)
  - Login field `disabled` in edit mode with tooltip "El login es permanente" (AD-FE-12)
  - Role multi-select with chips + popover (inline component `RoleMultiSelect` within same file — AD-FE-3)
    - Popover using `createPortal` to avoid overflow clipping
    - System roles section + custom roles section grouping
    - Keyboard: ↑/↓/Enter/Esc navigation
    - ARIA: `role="combobox"` on input, `role="listbox"` on popover, `role="option"` on items (AD-FE-8)
  - Submit handler: resolves mutations (update + optional changePassword + optional setRoles) per design B.6
  - Error mapping per `mapServerError` table from design B.6 (inline field highlight + banner)
  - Footer with `[Cancelar]` + `[Guardar]` (disabled + spinner while `loading`, per AD-FE-6)
  - `role="dialog" aria-modal="true" aria-labelledby` on modal root (AD-FE-8)
  - Focus trap implementation (restore focus on close)
- [ ] Create `src/pages/system/admin/RbacUsersBody.module.css` with:
  - Badge styles for 6 system roles + custom role (per design B.4 token names)
  - Skeleton shimmer animation (AD-FE-5)
  - Layout tokens for role chips, popover

---

## Phase 11 — FE: RbacUsersBody Component

### 11.1 [RED] RbacUsersBody tests

- [ ] Create `src/__tests__/pages/system/admin/RbacUsersBody.test.tsx` with tests:
  ```ts
  // helper setup
  const idleMutation = { mutateAsync: vi.fn(), isPending: false } as any;
  function renderBody() { return render(<RbacUsersBody />, { wrapper: MemoryRouter }); }
  ```
  - Loading state: `isPending=true` → skeleton rows rendered (not data table)
  - Empty state (no users, no filters): empty state card with "No hay usuarios registrados" copy and CTA button
  - Populated state: 2 users → 2 table rows with correct name, email, login
  - Roles as chips: role badges render using `RBAC_ROLE_LABELS` dict (e.g. `super_admin` → "Super Admin")
  - Clicking "Nuevo usuario" button → `RbacUserModal` rendered in create mode
  - Clicking "Editar" on a row → `RbacUserModal` rendered with `initialValues` pre-filled
  - Delete: clicking "Eliminar" → confirmation shown; on confirm, `useDeleteRbacUser().mutateAsync(id)` called
  - Delete error `CANNOT_DELETE_SELF` → error toast/alert shown
  - Delete error `CANNOT_REMOVE_LAST_SUPER_ADMIN` → error toast/alert shown

### 11.2 [GREEN] RbacUsersBody implementation

- [ ] Create `src/pages/system/admin/RbacUsersBody.tsx` (named export `export function RbacUsersBody`) with:
  - State: `showCreate`, `editingUser: RbacUserWithRolesDto | null`
  - `useRbacUsers()` for list; `useRbacRoles()` for role multi-select seed
  - `useDeleteRbacUser()` mutation with error handling
  - Table columns per spec (Nombre, Email, Login, Roles, Estado, Última sesión, Acciones)
  - Roles cell: chips using `RBAC_ROLE_LABELS` with fallback to `role.label`; max 3 visible with `+N` overflow (AD-FE-10)
  - Status badge: `active` → green "Activo", `disabled` → gray "Inactivo"
  - Última sesión: `lastLoginAt` as relative time (e.g. "Hace 3 días") or "Nunca" if null
  - Empty state card with bootstrap env hint copy (AD-FE-4)
  - Skeleton rows (3–5 rows matching column count) while loading (AD-FE-5)
  - Delete confirmation: `window.confirm("¿Eliminás a {name} ({login})? Esta acción no se puede deshacer.")` (AD-FE-9)
  - Mount `<RbacUserModal>` when `showCreate || editingUser` (pass `onClose` + `onSaved`)

### 11.3 IMPECCABLE audit

- [ ] Review the component against the 12 AD-FE decisions in the design (Part B.10):
  - AD-FE-1: table dominates viewport, modal is overlay ✓ (verify structure)
  - AD-FE-2: form library confirmed (zod or plain RHF) ✓
  - AD-FE-3: RoleMultiSelect inline in same file ✓
  - AD-FE-4: empty state is a bootstrap hint card ✓
  - AD-FE-5: skeleton loading, not spinner ✓
  - AD-FE-6: sticky header, Esc closes, dirty confirm on outside click ✓
  - AD-FE-7: dual-layer error feedback (field highlight + banner) ✓
  - AD-FE-8: aria labels, aria-describedby, role="dialog" ✓
  - AD-FE-9: native window.confirm for delete ✓
  - AD-FE-10: badge color per system role, neutral for custom ✓
  - AD-FE-11: password section collapsed in edit mode by default ✓
  - AD-FE-12: login field immutable in edit mode ✓
- [ ] Fix any AD-FE decision not reflected in the implementation

---

## Phase 12 — FE: AdminPage Integration

### 12.1 Read current AdminPage.tsx

- [ ] Read `src/pages/system/AdminPage.tsx` to identify the exact tab definition structure (keys: `id`, `label`, content — or the actual prop names used)

### 12.2 [RED] Update AdminPage tests (if applicable)

- [ ] Check `src/__tests__/pages/system/AdminPage.test.tsx` (or equivalent) for tests asserting the legacy admins tab content (`AdminsBody`, "Administradores" label, etc.)
- [ ] Update those tests to assert: tab id `'admins'`, label `"Usuarios"`, content renders `<RbacUsersBody />`

### 12.3 [GREEN] Patch AdminPage.tsx

- [ ] Modify `src/pages/system/AdminPage.tsx`:
  - Add import `import { RbacUsersBody } from './admin/RbacUsersBody'`
  - Find the tab entry with `id: 'admins'`
  - Change label to `"Usuarios"`
  - Replace content from `<AdminsBody />` to `<RbacUsersBody />`
  - Keep legacy `import { AdminsBody }` if other places reference it; otherwise leave it unused (SDD #6 cleanup)
  - Tab id `'admins'` MUST NOT change (decision #1)

---

## Phase 13 — FE: Quality Gates

### 13.1 Full suite green

- [ ] Run `npx vitest run` — all tests pass (0 failures)
- [ ] Fix any regressions introduced by the AdminPage patch

### 13.2 TypeScript clean

- [ ] Run `npx tsc --noEmit` in `ipnext-frontend` — 0 errors
- [ ] Fix any type errors (missing types, incorrect hook signatures, CSS module imports)

### 13.3 FE commit checkpoint

- [ ] Draft conventional commit message (user controls the actual commit):
  ```
  feat(rbac): user management UI — CRUD, role multi-select, modal, AdminPage integration
  ```
  Scope includes: types, API, hooks, RbacUsersBody, RbacUserModal, AdminPage patch, full test coverage.

---

## Deploy Runbook (for user — NOT a task for the apply agent)

> These steps must be done manually BEFORE pushing the BE commit to avoid a deadlock.

1. Generate bcrypt hash locally:
   ```sh
   node -e "console.log(require('bcryptjs').hashSync('yourPassword', 10))"
   ```
2. Set the following secrets in EasyPanel (GitHub repo secrets):
   - `BOOTSTRAP_RBAC_LOGIN`
   - `BOOTSTRAP_RBAC_EMAIL`
   - `BOOTSTRAP_RBAC_NAME`
   - `BOOTSTRAP_RBAC_PASSWORD_HASH` (the hash generated in step 1, NOT the plain password)
3. Push BE commit → deploy runs: `prisma migrate deploy` → `bootstrap-rbac` (seeds super_admin) → container starts with RbacUser login
4. Push FE commit → new AdminPage tab with RBAC CRUD is live
5. Log in with the bootstrap credentials → create additional users from the UI

**WARNING**: If the secrets are NOT set before push, `bootstrap-rbac` exits as no-op, no RbacUser exists, and nobody can log in. DEADLOCK.

---

## Task Summary

| Phase | Repo | Type | Count |
|-------|------|------|-------|
| 1 — PasswordHasher + RbacUserRepository extensions | BE | RED + GREEN | 18 tasks |
| 2 — Domain errors + DTOs | BE | GREEN | 7 tasks |
| 3 — Use cases CRUD (6 UCs) | BE | RED + GREEN | 24 tasks |
| 4 — Use cases Roles (4 UCs) | BE | RED + GREEN | 16 tasks |
| 5 — Auth login rewrite | BE | RED + GREEN | 13 tasks |
| 6 — HTTP routes + DI wiring | BE | RED + GREEN | 12 tasks |
| 7 — Bootstrap script + deploy | BE | RED + GREEN | 9 tasks |
| 8 — BE quality gates | BE | gate | 5 tasks |
| 9 — FE types, API, hooks | FE | RED + GREEN | 21 tasks |
| 10 — FE RbacUserModal | FE | RED + GREEN | 11 tasks |
| 11 — FE RbacUsersBody | FE | RED + GREEN | 14 tasks |
| 12 — FE AdminPage integration | FE | RED + GREEN | 5 tasks |
| 13 — FE quality gates | FE | gate | 5 tasks |
| **Total** | | | **~160 tasks** |

**BE tasks**: ~104 | **FE tasks**: ~56 | **Phases**: 13
