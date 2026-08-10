# Tech API Auth Specification (Wave 1b)

## Purpose

Login dedicado para el técnico sobre su `RbacUser` existente (`prisma/schema.prisma:3291`), emitiendo un JWT `aud='tech'` que separa la superficie móvil de la de staff. Réplica exacta del patrón `/api/portal/*` (port `PortalTokenService` → `JwtPortalTokenService` → `portalAuthMiddleware`, `src/domain/ports/PortalTokenService.ts`, `src/infrastructure/adapters/jwt/JwtPortalTokenService.ts`, `src/infrastructure/http/middleware/portalAuthMiddleware.ts`), mismo `JWT_SECRET`, separación SOLO por `aud`.

No hay cuenta separada (`TechAccount`): el login usa `RbacUser.login` + `RbacUser.passwordHash` directamente (decisión cerrada).

## Requirements

### Requirement: Technician login requires the `tech.app_access` permission

El sistema DEBE (MUST) rechazar el login `/api/tech/auth/login` con un `RbacUser` válido si ese usuario no tiene el permiso `tech.app_access` (módulo `tech`, acción `app_access`, catálogo RBAC — mismo mecanismo que `rbac-permission-catalog-extension`), aunque login/password sean correctos.

El sistema DEBE (MUST) responder con el MISMO error genérico para: login inexistente, password incorrecta, `RbacUser.status !== 'active'`, y `RbacUser` sin `tech.app_access` (anti-enumeración, mismo criterio que `InvalidPortalCredentialsError`).

#### Scenario: Valid technician logs in
- GIVEN un `RbacUser` con `status='active'`, password correcta y rol con permiso `tech.app_access`
- WHEN hace `POST /api/tech/auth/login`
- THEN recibe `200` con `accessToken` (JWT `aud='tech'`) y `refreshToken`

#### Scenario: Staff without tech.app_access is rejected
- GIVEN un `RbacUser` activo con login/password correctos pero SIN el permiso `tech.app_access`
- WHEN hace `POST /api/tech/auth/login`
- THEN recibe `401 { code: 'INVALID_TECH_CREDENTIALS' }`, idéntico al de credenciales incorrectas

### Requirement: Bearer-only middleware re-checks status on every request

El middleware `techAuthMiddleware` DEBE (MUST) aceptar SOLO `Authorization: Bearer <token>` (sin cookies) y re-verificar `RbacUser.status === 'active'` Y el permiso `tech.app_access` en CADA request (no solo al login) — mismo contrato que `portalAuthMiddleware` re-chequeando `account.status`.

El sistema DEBE (MUST) setear `req.technicianId` como ÚNICA fuente de identidad para todo use case de `/api/tech/*` — nunca body/query (anti-IDOR estructural, mismo criterio que `req.portalClientId`).

#### Scenario: Revoked technician is rejected mid-session
- GIVEN un técnico con un `accessToken` válido y sin expirar
- AND un admin le quita el rol con `tech.app_access` O pone `status='inactive'`
- WHEN el técnico hace cualquier request a `/api/tech/*`
- THEN recibe `401 { code: 'UNAUTHORIZED' }` aunque el JWT siga siendo criptográficamente válido

### Requirement: Audience guard is enforced in BOTH directions

El sistema DEBE (MUST) rechazar un token `aud='tech'` contra CUALQUIER ruta `/api/admin/*` (extensión de `JwtAuthAdapter.getSession()`, `src/infrastructure/adapters/jwt/JwtAuthAdapter.ts:111`, que ya rechaza `aud==='portal'`).

El sistema DEBE (MUST) rechazar un token de staff (sin `aud`, o `aud≠'tech'`) contra CUALQUIER ruta `/api/tech/*`.

#### Scenario: Tech token does not open admin routes
- GIVEN un `accessToken` válido con `aud='tech'`
- WHEN se usa como Bearer contra `GET /api/admin/scheduling`
- THEN la respuesta es `401`, igual que un token `aud='portal'` hoy

#### Scenario: Staff token does not open tech routes
- GIVEN un JWT de staff válido (sin `aud`, cookie httpOnly)
- WHEN se usa como Bearer contra `GET /api/tech/tasks`
- THEN la respuesta es `401 { code: 'UNAUTHORIZED' }`

## HTTP Contract

### POST /api/tech/auth/login
Body: `{ login: string, password: string }`
Response `200`: `{ accessToken: string, refreshToken: string }` — mismo shape que `PortalLoginResult` sin `mustChangePassword` (RbacUser no tiene ese campo, verificado en `schema.prisma:3291`).
Errors:
| Status | code | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR` | falta `login` o `password` |
| 401 | `INVALID_TECH_CREDENTIALS` | login inexistente / password mala / inactivo / sin `tech.app_access` |

### POST /api/tech/auth/refresh
Body: `{ refreshToken: string }` → `200 { accessToken: string, refreshToken: string }`
Errors: `400 VALIDATION_ERROR` (falta el campo) | `401 { code: 'INVALID_TECH_REFRESH_TOKEN' }` (inválido/expirado/reusado — mismo body genérico que el portal para no confirmar reuso a un atacante)

### POST /api/tech/auth/logout
Body: `{ refreshToken: string }` → `204` (idempotente, best-effort, nunca falla ruidosamente)

### GET /api/tech/me
Headers: `Authorization: Bearer <accessToken>`
Response `200`: `{ id: string, name: string, login: string, iclassTeamLogin: string | null }` (campos verificados contra `RbacUser`, `schema.prisma:3291-3304`)
Errors: `401 { code: 'UNAUTHORIZED' }`

**TTLs (pineados en sdd-design, valores concretos — no "espejo" genérico):**
- `accessToken`: **15 minutos (900 segundos)**. Valor exacto de `JwtPortalTokenService.ts:4` (`ACCESS_TOKEN_TTL_SECONDS = 15 * 60`), confirmado por `design.md` Decision 1 ("Adapter `JwtTechTokenService`: TTL 15 min").
- `refreshToken`: **30 días** (`PORTAL_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000`, `PortalLogin.ts:9`), con la MISMA rotación + detección de reuso que el refresh del portal (`RefreshPortalSession.ts`) — el técnico NO re-loguea cada 15 minutos. Sigue la recomendación de `design.md` (Open Questions): "clonar la rotación del portal — un técnico re-logueándose con guantes en un techo es inaceptable". El nombre exacto de la tabla de sesiones (`design.md` deja abierto si se llama `TechRefreshToken` o se reusa otro esquema) queda fuera del alcance de este spec — es detalle de implementación, no de contrato.

## Aditivo, solo-crece
Todo campo nuevo en las responses de este contrato se agrega, nunca se renombra ni se borra (hay apps instaladas).
