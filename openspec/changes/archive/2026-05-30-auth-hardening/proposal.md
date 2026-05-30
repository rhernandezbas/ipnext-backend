# Proposal — auth-hardening (SDD #6a)

> Status: PROPOSAL · Artifact store: hybrid · Mode: interactive
> Repos: ipnext-backend (BE) — FE touch minimal (error messages only)
> First slice of SDD #6 security-hardening. Siblings deferred: #6c session-policy, #6b refresh-tokens, #6e admin-legacy-drop, #6d 2FA-on-RbacUser.

## Intent / Why

El endpoint de login está sin protección de fuerza bruta (sin rate limit, sin
lockout), la password policy es solo "min 8 chars", y —lo más grave— **la cookie
de sesión corre con `secure=false` en producción**: `JwtAuthAdapter` decide
`secure` con `NODE_ENV==='production'`, pero prod corre con `NODE_ENV=development`
(gotcha documentado) → el token viaja sin exigir HTTPS. Endurecemos el login y
tapamos esa vulnerabilidad.

## Scope

### In (BE)
- **Cookie secure fix** (vuln de prod): nueva env `COOKIE_SECURE` (independiente de `NODE_ENV`); `JwtAuthAdapter` usa `config.cookieSecure`.
- **CORS por env**: `CORS_ORIGIN` (default `http://localhost:5173`) en vez del hardcode.
- **Security headers**: `helmet` montado en `app.ts`.
- **Rate limit** en `POST /api/auth/login` (y `/logout` no; sí podría `/login`): `express-rate-limit`, p.ej. 10 intentos / 15 min por IP → 429.
- **Account lockout**: `RbacUser` += `failedLoginCount` (Int, default 0) + `lockedUntil` (DateTime?). `LoginRbacUser` incrementa en fallo, resetea en éxito, y si `lockedUntil > now` rechaza con `AccountLockedError` (lock tras N=5 fallos por T=15 min).
- **Password policy**: validador de dominio `PasswordPolicy` (min 10, al menos 1 letra + 1 dígito; configurable) aplicado en `CreateRbacUser` + `ChangeRbacUserPassword`. Solo afecta passwords NUEVOS (create/change); no rompe logins existentes.

### Out (explícito)
- Refresh tokens / rotación → #6b.
- Session policy (idle/concurrent/max duration) → #6c.
- Admin legacy drop → #6e.
- 2FA en RbacUser / enforcement → #6d.
- Session-check caching (perf) → futuro.
- HTTPS redirect / HSTS a nivel infra → reverse proxy (fuera de la app).

## Approach

### Cookie secure (fix de la vuln)
`config.ts` agrega `cookieSecure = process.env.COOKIE_SECURE === 'true'` (default false). `JwtAuthAdapter` recibe/lee `cookieSecure` y lo usa en login + logout cookie options. **Acción de operador (runbook): setear `COOKIE_SECURE=true` en prod** (vía secret/env). Sin eso, sigue como hoy (no rompe), pero queda documentado como paso obligatorio.

### CORS + helmet
`config.corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173'`. `app.use(helmet())` antes de las rutas (API JSON → CSP de bajo impacto; se usa el default, se documenta si algo necesita tuning). `cors({ origin: config.corsOrigin, credentials: true })`.

### Rate limit
`express-rate-limit` middleware aplicado solo a `POST /api/auth/login` (windowMs 15min, max 10, keyGenerator por IP). Devuelve 429 con `{ code: 'RATE_LIMITED' }`. Montado en la route de auth.

### Account lockout (hexagonal)
- Migración aditiva: `RbacUser.failedLoginCount Int @default(0)`, `RbacUser.lockedUntil DateTime?`.
- `RbacUserRepository` += métodos para el contador (ej. `registerFailedLogin(id)`, `resetFailedLogins(id)`, o un `update` parcial — reusar el `update` existente si alcanza).
- `LoginRbacUser`: al resolver el user, si `lockedUntil && lockedUntil > now` → `AccountLockedError` (sin revelar si el pass era correcto). En password incorrecto → incrementar `failedLoginCount`; si llega a 5 → setear `lockedUntil = now + 15min` y resetear contador. En éxito → resetear contador + `lockedUntil = null`. Mantiene el mensaje genérico (no enumera usuarios).
- `AccountLockedError` (code `ACCOUNT_LOCKED`, HTTP 423 o 429) en errorHandler.

### Password policy
- Dominio: `validatePassword(plain): void | throws` (min 10, ≥1 letra, ≥1 dígito; reglas en una constante configurable). Errores `PasswordPolicyError` (code `PASSWORD_POLICY`) con mensaje claro.
- Aplicar en `CreateRbacUser` y `ChangeRbacUserPassword` (reemplaza/extiende el `PasswordTooShortError` actual).
- FE: el modal de crear/cambiar password muestra el mensaje del error (ajuste menor, si aplica).

## Phases (tentativo)
1. **Config hardening** (cookie secure + CORS env + helmet): config.ts + JwtAuthAdapter + app.ts. Tapa la vuln de cookie. Dep: helmet.
2. **Rate limit**: express-rate-limit en /login. Dep: express-rate-limit.
3. **Lockout**: RbacUser fields + migración + LoginRbacUser + AccountLockedError + errorHandler.
4. **Password policy**: validador + aplicar en create/change + PasswordPolicyError.
5. **Verify + deploy**: tests → BE deploy (migración + **setear COOKIE_SECURE=true**) → verificación → archive.

## Risks / decisiones
- **Lockout mal configurado** bloquea usuarios legítimos → defaults conservadores (5 fallos / 15 min) + reset en éxito. Self-service unlock o admin reset queda para iterar.
- **helmet CSP** podría romper algo → es API JSON; usar default, monitorear; desactivar CSP si molesta.
- **COOKIE_SECURE** requiere acción de operador en prod (setear =true) — si se olvida, no rompe pero la vuln sigue. Flag en runbook + verify.
- **Rate limit detrás de proxy**: el `keyGenerator` por IP necesita `app.set('trust proxy', ...)` correcto para leer la IP real (prod corre tras EasyPanel) — revisar en apply.
- **Password policy** solo afecta create/change (no logins ni passwords existentes) — sin ruptura.
- Deps nuevas (helmet, express-rate-limit) → `npm install` en apply (el Docker build las toma).
