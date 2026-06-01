# Tasks: auth-hardening (SDD #6a)

> TDD estricto: tests RED → impl GREEN → refactor por fase. BE = ipnext-backend.
> Commits independientes por repo, push = PROD (confirmar cada uno). No `npm run build`.
> Deps nuevas: `helmet`, `express-rate-limit` (npm install en P1/P2).

## Phase 1 — Config hardening (cookie secure + CORS env + helmet)  ← tapa la vuln de prod

### T-1: Config
- [ ] `config.ts`: agregar `cookieSecure` (= `COOKIE_SECURE === 'true'`) y `corsOrigin` (= `CORS_ORIGIN ?? 'http://localhost:5173'`). Documentar en `env.example`.

### T-2: Tests RED
- [ ] `JwtAuthAdapter` test: `secure` de las cookie options (login + logout) refleja el flag inyectado (true/false).

### T-3: GREEN
- [ ] `JwtAuthAdapter` recibe `cookieSecure` (constructor o config) y lo usa en login + logout (en vez de `NODE_ENV==='production'`).
- [ ] `npm install helmet`; `app.ts`: `app.use(helmet())` antes de routers; `cors({ origin: config.corsOrigin, credentials: true })`.
- [ ] Wire `cookieSecure` en `new JwtAuthAdapter(...)` en app.ts.

### T-4: Cierre P1
- [ ] `npx jest` + `tsc` verde
- [ ] Commit BE: `feat(security): cookie secure por env + helmet + CORS configurable (Phase 1)`

## Phase 2 — Rate limit en /login

### T-5: Tests RED
- [ ] `src/__tests__/infrastructure/loginRateLimit.test.ts` (supertest): con un limiter de `max` bajo, el request N+1 a `POST /api/auth/login` → 429 `RATE_LIMITED`.

### T-6: GREEN
- [ ] `npm install express-rate-limit`; crear `loginRateLimiter` (windowMs 15min, max 10, handler → 429 `{code:'RATE_LIMITED'}`).
- [ ] Inyectar el limiter en `createAuthRouter` (default en app.ts); aplicarlo SOLO a `POST /login`.
- [ ] `app.set('trust proxy', 1)` en app.ts (verificar valor real para EasyPanel → IP correcta).

### T-7: Cierre P2
- [ ] `npx jest` + `tsc` verde
- [ ] Commit BE: `feat(security): rate limit en POST /login (Phase 2)`

## Phase 3 — Account lockout

### T-8: Tests RED
- [ ] `LoginRbacUser` test (in-memory RbacUser repo + fake hasher + clock inyectado): 5 fallos → `lockedUntil` ~15min futuro; cuenta bloqueada rechaza con `AccountLockedError` aun con password correcto; éxito resetea `failedLoginCount`/`lockedUntil`; user desconocido → `AuthenticationError` genérico sin lock.

### T-9: GREEN
- [ ] schema.prisma: `RbacUser` += `failedLoginCount Int @default(0)` + `lockedUntil DateTime?`. Migración aditiva (timestamp posterior a las existentes; revisar colisión).
- [ ] `domain/errors`: `AccountLockedError` (code `ACCOUNT_LOCKED`).
- [ ] `LoginRbacUser`: lógica de lock/reset (constantes MAX_FAILED=5, LOCK_MINUTES=15, clock inyectable). Persistir vía `RbacUserRepository.update` (extender campos permitidos si hace falta; in-memory + prisma).
- [ ] `errorHandler`: `ACCOUNT_LOCKED: 423`.

### T-10: Cierre P3
- [ ] `npx jest` + `tsc` verde
- [ ] Commit BE: `feat(security): account lockout tras 5 fallos (Phase 3)`

## Phase 4 — Password policy

### T-11: Tests RED
- [ ] `validatePassword` unit (too short / sin dígito / sin letra / válido).
- [ ] `CreateRbacUser` + `ChangeRbacUserPassword`: password débil → `PasswordPolicyError`.

### T-12: GREEN
- [ ] `domain/services/passwordPolicy.ts`: `validatePassword` + `PASSWORD_RULES` (min 10, ≥1 letra, ≥1 dígito) + `PasswordPolicyError` (code `PASSWORD_POLICY`).
- [ ] Aplicar en `CreateRbacUser` + `ChangeRbacUserPassword` (reemplaza el chequeo de longitud suelto).
- [ ] `errorHandler`: `PASSWORD_POLICY: 400`.

### T-13: Cierre P4
- [ ] `npx jest` + `tsc` verde
- [ ] Commit BE: `feat(security): password policy en create/change (Phase 4)`

## Phase 5 — Verify + deploy

### T-14: Verify
- [ ] Suite completa BE (`npx jest`) + `tsc` verde
- [ ] `/sdd-verify` contra spec

### T-15: Deploy (gates de push, uno por uno)
- [ ] Rebase sobre origin/main (CHEQUEAR colisión de timestamp de migración). Push BE → `gh run watch` (incluye migración aditiva). Confirmar step de migraciones verde.
- [ ] **ACCIÓN DE OPERADOR EN PROD: setear `COOKIE_SECURE=true`** (y opcional `CORS_ORIGIN`) vía `gh secret set` / env de EasyPanel. Sin esto, la cookie sigue insegura.
- [ ] Smoke: login OK; ver headers de helmet (curl -I); probar lockout/rate-limit con cuidado en un user de prueba (no bloquear superadmin).

### T-16: Archive
- [ ] `/sdd-archive` — sync `auth-hardening` spec → openspec/specs/, mover change a archive/
