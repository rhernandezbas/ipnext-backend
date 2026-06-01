# Design: auth-hardening

## Architecture Decisions

### AD-1: COOKIE_SECURE env, not NODE_ENV (fixes prod vuln)
`config.ts` adds `cookieSecure: process.env.COOKIE_SECURE === 'true'`. `JwtAuthAdapter` takes the flag via constructor (or reads config) and uses it in BOTH login and logout cookie options. Root cause fixed: prod runs `NODE_ENV=development`, so the old `secure: NODE_ENV==='production'` was always false. **Operator must set `COOKIE_SECURE=true` in prod** (deploy runbook + verify-report). Default false keeps local dev working over http.

### AD-2: helmet default + CORS env
`app.use(helmet())` mounted right after `express.json()`/`cookieParser()`, before routers. It's a JSON API (the SPA is a separate origin), so the default CSP is low-impact; documented to tune if anything breaks. CORS: `cors({ origin: config.corsOrigin, credentials: true })` where `config.corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173'`.

### AD-3: Rate limit on /login (express-rate-limit)
A `loginRateLimiter` (windowMs 15min, max 10, standardHeaders, `handler` → 429 `{code:'RATE_LIMITED'}`) applied ONLY to `POST /api/auth/login` in the auth router. Key = client IP. **Needs `app.set('trust proxy', 1)`** (or appropriate value) so the limiter sees the real client IP behind EasyPanel's proxy — otherwise all requests share the proxy IP. Resolve the exact trust-proxy value in apply (likely `1`). The limiter is injectable into `createAuthRouter` (default-constructed in app.ts) so route tests can pass a permissive/strict one.

### AD-4: Account lockout (hexagonal)
- Migration (additive): `RbacUser.failedLoginCount Int @default(0)`, `RbacUser.lockedUntil DateTime?`.
- `RbacUserRepository` gains a way to persist these. Prefer reusing the existing `update(id, partial)` (it already supports partial RbacUser updates) — extend the allowed fields to include `failedLoginCount` + `lockedUntil`. No new port methods if `update` suffices.
- `LoginRbacUser` orchestrates (constants `MAX_FAILED=5`, `LOCK_MINUTES=15`, injectable for tests + a `now()` clock seam):
  1. find user by login; unknown → `AuthenticationError` (generic, unchanged).
  2. if `lockedUntil && lockedUntil > now` → `AccountLockedError` (before password check).
  3. if status !== active → `AuthenticationError` (unchanged).
  4. compare password:
     - fail → `failedLoginCount+1`; if reaches MAX_FAILED → set `lockedUntil = now + LOCK_MINUTES`, reset count to 0; persist; throw `AuthenticationError`.
     - ok → reset `failedLoginCount=0`, `lockedUntil=null`, `updateLastLogin`; return user.
- `AccountLockedError` in domain/errors/auth (or rbacUser.errors), code `ACCOUNT_LOCKED`. errorHandler statusMap `ACCOUNT_LOCKED: 423`.
- Enumeration note: lockout only triggers/reports for REAL users (a locked account is discoverable, standard tradeoff). Unknown logins never lock and keep the generic 401.

### AD-5: Password policy (domain service)
`src/domain/services/passwordPolicy.ts` (or under domain): `validatePassword(plain: string): void` throwing `PasswordPolicyError` (code `PASSWORD_POLICY`) when rules fail. Rules in a `PASSWORD_RULES` constant: minLength 10, requireLetter, requireDigit. Pure, no deps (zxcvbn deferred). Applied in `CreateRbacUser` (replaces the bare length check) and `ChangeRbacUserPassword`. errorHandler `PASSWORD_POLICY: 400`. The existing `PasswordTooShortError` (PASSWORD_TOO_SHORT, 400) can stay or be subsumed; keep both codes mapped to avoid breaking other callers.

### AD-6: Injectability for tests
Rate limiter + clock (`now`) + policy are injected/seamed so unit + supertest tests are deterministic (no real timers, no wall-clock). LoginRbacUser already constructor-injects repos + hasher; add an optional clock.

---

## Migration Strategy
Additive only — `ALTER TABLE "RbacUser" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "lockedUntil" TIMESTAMP(3);`. Generated via `prisma migrate diff`. Timestamp LATER than any concurrent migration (check at apply — collisions have happened repeatedly with other agents). No data transformation, no drops → safe direct push.

## Testing Strategy (TDD)
- **LoginRbacUser** (in-memory RbacUser repo + fake hasher + injected clock): lock after 5 fails; locked rejects correct password (423/AccountLockedError); success resets count + lockedUntil; unknown user → generic error (no lock).
- **password policy**: validatePassword unit tests (too short, no digit, no letter, valid); CreateRbacUser/ChangeRbacUserPassword reject weak → PASSWORD_POLICY.
- **rate limit**: supertest on a tiny app with the limiter → 11th request 429. (Use a low max in the test instance.)
- **cookie secure**: JwtAuthAdapter unit — secure reflects the injected flag for login + logout.
- **errorHandler**: ACCOUNT_LOCKED→423, RATE_LIMITED handled by limiter, PASSWORD_POLICY→400.
- Full jest + tsc green before commit.

## Open decisions for apply
- `trust proxy` exact value for EasyPanel (1 vs true) — verify what yields the real IP.
- AccountLockedError location (new domain/errors/auth.errors.ts vs rbacUser.errors.ts) — pick in apply.
- helmet CSP: keep default; if it interferes with anything served, narrow contentSecurityPolicy.
- Whether to also rate-limit other auth endpoints (/logout, /me) — out for now, only /login.
