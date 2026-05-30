# Spec: Auth Hardening

**Capability**: `auth-hardening` (NEW)
**Change**: `auth-hardening`
**Summary**: Endurece el login: cookie `secure` por env (tapa la vuln de prod), security headers (helmet), CORS por env, rate limit + account lockout contra fuerza bruta, y password policy en create/change.

---

## Added Requirements

### REQ-AH-COOKIE-1: Cookie secure por configuración explícita

El flag `secure` de la cookie `auth_token` MUST derivar de una env `COOKIE_SECURE` (no de `NODE_ENV`). `config.cookieSecure = (process.env.COOKIE_SECURE === 'true')`. `JwtAuthAdapter` (login + logout) MUST usar `config.cookieSecure`.

#### Scenario: COOKIE_SECURE=true → cookie segura
**Given** `COOKIE_SECURE=true`
**When** un login exitoso setea la cookie
**Then** las cookie options MUST tener `secure: true` (independiente de `NODE_ENV`)

#### Scenario: ausente → false (comportamiento actual, no rompe)
**Given** `COOKIE_SECURE` sin setear
**When** se setea la cookie
**Then** `secure: false` (se documenta que prod DEBE setear `COOKIE_SECURE=true`)

### REQ-AH-CORS-1: CORS por env

El origin de CORS MUST leerse de `CORS_ORIGIN` (default `http://localhost:5173`). `credentials: true` se mantiene.

### REQ-AH-HEADERS-1: Security headers

La app MUST montar `helmet` antes de las rutas, agregando los headers de seguridad por defecto (X-Content-Type-Options, X-Frame-Options, etc.).

### REQ-AH-RATELIMIT-1: Rate limit en login

`POST /api/auth/login` MUST estar protegido por rate limit por IP (ventana 15 min, máx 10 intentos). Excedido → **429** con `{ code: 'RATE_LIMITED' }`.

#### Scenario: exceso de intentos → 429
**Given** 10 requests a `POST /api/auth/login` desde una IP en la ventana
**When** llega el intento 11
**Then** MUST responder 429 con `code: RATE_LIMITED` sin tocar la lógica de auth

### REQ-AH-LOCKOUT-1: Account lockout

`RbacUser` MUST tener `failedLoginCount` (Int, default 0) y `lockedUntil` (DateTime?). `LoginRbacUser`:
- éxito → resetea `failedLoginCount=0`, `lockedUntil=null`
- password incorrecto en user existente → incrementa `failedLoginCount`; al llegar a 5 → `lockedUntil = now + 15min` (y resetea el contador)
- si `lockedUntil` está en el futuro → rechaza con `AccountLockedError` (code `ACCOUNT_LOCKED`, 423) ANTES de chequear el password
- user desconocido → sigue dando `AuthenticationError` genérico (no se crea lock, no se enumera)

#### Scenario: 5 fallos bloquean la cuenta
**Given** un user existente con 4 fallos previos
**When** falla el password una 5ta vez
**Then** `lockedUntil` MUST quedar ~15 min en el futuro

#### Scenario: cuenta bloqueada rechaza incluso con password correcto
**Given** un user con `lockedUntil` en el futuro
**When** intenta loguear (aun con el password correcto)
**Then** MUST responder 423 `ACCOUNT_LOCKED` (no se valida el password)

#### Scenario: login exitoso resetea el contador
**Given** un user con `failedLoginCount=3` y sin lock
**When** loguea con el password correcto
**Then** `failedLoginCount` MUST quedar en 0 y `lockedUntil` en null

### REQ-AH-PWPOLICY-1: Password policy en create/change

Las contraseñas NUEVAS (en `CreateRbacUser` y `ChangeRbacUserPassword`) MUST cumplir: longitud ≥ 10, al menos 1 letra y al menos 1 dígito. Incumplimiento → `PasswordPolicyError` (code `PASSWORD_POLICY`, 400) con mensaje claro. NO aplica a logins ni a passwords ya existentes.

#### Scenario: password débil rechazado al crear
**Given** un `POST /api/admin/rbac/users` con `password: "corta"`
**When** se procesa
**Then** MUST responder 400 con `code: PASSWORD_POLICY`

#### Scenario: password válido aceptado
**Given** un password `"Segura1234"` (≥10, letra+dígito)
**When** se crea/cambia
**Then** MUST aceptarse

---

## Appendix: Error Codes / Status

| Scenario | HTTP | `code` |
|----------|------|--------|
| Rate limit excedido | 429 | `RATE_LIMITED` |
| Cuenta bloqueada | 423 | `ACCOUNT_LOCKED` |
| Password no cumple policy | 400 | `PASSWORD_POLICY` |
| Credenciales inválidas (sin cambios) | 401 | `INVALID_CREDENTIALS` |
