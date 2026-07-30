# Portal Auth Specification

## Purpose

Autenticar CLIENTES finales (no staff) contra su `PortalAccount` con **DNI + password
autogenerada**, emitiendo tokens con **audience `portal`** — un universo de identidad separado
del JWT admin: un token de portal JAMÁS pasa un guard de staff y viceversa.

**Fuera de alcance:** self-registration (las cuentas las crea el CRUD admin), recuperación
autónoma de password (la regenera el operador), y el canal de entrega de la password.

## Requirements

### Requirement: Login por DNI + password
`POST /api/portal/auth/login` con `{dni, password}` DEBE (MUST) validar contra el
`PortalAccount` cuyo `dni` coincida exactamente y cuyo `status` sea `active`, comparando la
password con el hash bcrypt almacenado. En éxito DEBE devolver un access token JWT con
`aud=portal`, `sub=<portalAccountId>` y el `clientId` como claim, expiración ≤ 15 minutos, más
un refresh token opaco (rotativo, persistido hasheado en `PortalSession`).

#### Scenario: Login exitoso
- **WHEN** un cliente con cuenta activa envía su DNI y la password correcta
- **THEN** recibe `{accessToken, refreshToken, mustChangePassword}` y `lastLoginAt` se actualiza

#### Scenario: Password incorrecta
- **WHEN** la password no coincide
- **THEN** 401 con mensaje genérico ("DNI o contraseña incorrectos") — el mensaje NO DEBE
  distinguir "DNI inexistente" de "password incorrecta" (anti user-enumeration)

#### Scenario: Cuenta deshabilitada
- **WHEN** la cuenta existe pero `status = disabled`
- **THEN** 401 con el MISMO mensaje genérico (no filtrar que la cuenta existe)

### Requirement: Tokens de portal rechazados en rutas admin (y viceversa)
El middleware admin DEBE (MUST) rechazar con 401 cualquier JWT cuyo `aud` sea `portal`, y el
middleware de portal DEBE rechazar cualquier JWT sin `aud=portal` (incluidos tokens admin
válidos). La separación es por audience, no por convención.

#### Scenario: Token de portal contra ruta admin
- **WHEN** un access token de portal válido se envía a `GET /api/admin/...`
- **THEN** 401 — jamás 200 ni 403 con datos

#### Scenario: Token admin contra ruta de portal
- **WHEN** un JWT admin válido se envía a `GET /api/portal/me`
- **THEN** 401

### Requirement: Refresh rotativo y logout
`POST /api/portal/auth/refresh` DEBE (MUST) aceptar un refresh token vigente, emitir un nuevo
par access+refresh e invalidar el refresh usado (rotación: un refresh se usa UNA vez).
`POST /api/portal/auth/logout` DEBE revocar la sesión del refresh presentado.

#### Scenario: Refresh reusado
- **WHEN** un refresh token ya rotado se presenta de nuevo
- **THEN** 401 y TODAS las sesiones de esa cuenta se revocan (señal de robo de token)

### Requirement: Cambio de password in-app
`POST /api/portal/auth/change-password` (autenticado) DEBE (MUST) exigir la password actual,
validar la nueva (mínimo 8 caracteres) y limpiar `mustChangePassword`. Las cuentas nuevas o con
password regenerada nacen con `mustChangePassword = true` y el login lo informa.

#### Scenario: Primer login con password autogenerada
- **WHEN** un cliente entra con la password que le generó el operador
- **THEN** el login responde `mustChangePassword: true` y la app fuerza el cambio

### Requirement: Rate limiting del login
El login DEBE (MUST) tener rate limit dedicado (más estricto que el general del API) por
combinación IP+DNI, devolviendo 429 al excederlo. Los endpoints `/api/portal/*` autenticados
DEBEN tener un rate limit general por cuenta.

#### Scenario: Fuerza bruta sobre un DNI
- **WHEN** se exceden los intentos de login permitidos para un DNI desde una IP
- **THEN** 429 sin evaluar credenciales

### Requirement: Kill-switch global del portal
Si `ClientPortalSettings.enabled = false`, TODO `/api/portal/*` DEBE (MUST) responder 503 con
mensaje claro, sin evaluar credenciales ni tocar datos. Las rutas admin del CRUD de cuentas NO
dependen del flag (el operador prepara cuentas antes del go-live).

#### Scenario: Portal apagado
- **WHEN** `enabled = false` y llega cualquier request a `/api/portal/*` (incluido login)
- **THEN** 503 `PORTAL_DISABLED`
