# Spec: Sessions

**Capability**: `sessions` (NEW)
**Change**: `sessions-management`
**Summary**: Sesiones reales por login (atadas a `RbacUser`, con `tokenHash`). La auth pasa a ser **stateful**: cada request valida que la sesión exista y no esté revocada. Se pueden listar y revocar sesiones (una sola + todas las de un usuario). Reemplaza la pestaña "Sesiones" mock del FE.

---

## Added Requirements

### REQ-SES-MODEL-1: Modelo y puerto

El sistema MUST persistir sesiones en una tabla `Session` con: `id` (uuid), `rbacUserId` (FK→`RbacUser`, `onDelete: Cascade`), `tokenHash` (string único = sha256 del JWT), `ip` (nullable), `userAgent` (nullable), `loginAt`, `lastSeenAt`, `revokedAt` (nullable; null = activa), `createdAt`. MUST indexar `rbacUserId`, `tokenHash`, `revokedAt`.

El dominio MUST exponer en `src/domain/ports/`:
```ts
interface Session {
  id: string; rbacUserId: string; tokenHash: string;
  ip: string | null; userAgent: string | null;
  loginAt: string; lastSeenAt: string; revokedAt: string | null; createdAt: string;
}
interface SessionRepository {
  create(input: { rbacUserId: string; tokenHash: string; ip: string | null; userAgent: string | null }): Promise<Session>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  findById(id: string): Promise<Session | null>;
  listActive(query: { rbacUserId?: string; page?: number; pageSize?: number }): Promise<{ items: Session[]; total: number; page: number; pageSize: number }>;
  revoke(id: string): Promise<void>;
  revokeAllForUser(rbacUserId: string): Promise<number>;
  touch(id: string): Promise<void>; // updates lastSeenAt
}
```
El `tokenHash` MUST ser un hash (sha256) — el JWT crudo MUST NOT persistirse.

### REQ-SES-CREATE-1: El login crea una sesión

#### Scenario: Login exitoso registra una sesión activa
**Given** un `POST /api/auth/login` con credenciales válidas
**When** se emite el JWT
**Then** MUST crearse una `Session` con `tokenHash = sha256(jwt)`, `ip`/`userAgent` del request, `revokedAt = null`
**And** si la creación de la sesión falla, el token NO MUST entregarse (fail-safe)

### REQ-SES-AUTH-1: Validación stateful por request

El middleware de auth MUST, tras verificar la firma del JWT, validar que exista una `Session` con `tokenHash = sha256(token)` y `revokedAt = null`. Si no existe o está revocada → **401**.

#### Scenario: Request con sesión activa
**Given** un request autenticado cuyo token corresponde a una sesión activa
**When** se procesa
**Then** MUST continuar normalmente (200/según endpoint)

#### Scenario: Request con sesión revocada
**Given** un token cuya `Session` tiene `revokedAt != null`
**When** se procesa un request autenticado
**Then** MUST responder 401 (`code: UNAUTHORIZED`)

#### Scenario: Token válido sin sesión (pre-#5 o manipulado)
**Given** un JWT con firma válida pero sin `Session` registrada
**When** se procesa
**Then** MUST responder 401

### REQ-SES-LASTSEEN-1: lastSeenAt con throttle

El sistema SHOULD actualizar `lastSeenAt` de la sesión en requests autenticados, pero MUST evitar escribir en cada request: solo actualiza si pasaron > 5 minutos desde el último `lastSeenAt`.

### REQ-SES-LOGOUT-1: Logout revoca la sesión actual

#### Scenario: Logout revoca y limpia
**Given** un `POST /api/auth/logout` autenticado
**When** se procesa
**Then** MUST marcar `revokedAt` de la sesión actual (por `tokenHash`)
**And** MUST limpiar la cookie `auth_token`
**And** un request posterior con ese token MUST dar 401

### REQ-SES-LIST-1: Listar sesiones activas

El sistema MUST exponer `GET /api/admin/sessions` protegido por `requirePerm('admin','view_sessions')`, paginado, devolviendo **DTOs** (incluye `actorLogin` resuelto; nunca `tokenHash`).

#### Scenario: Listado paginado de sesiones activas
**Given** un `GET /api/admin/sessions?page=1&pageSize=50` con permiso
**When** se procesa
**Then** MUST responder 200 con `{ items: SessionDto[], total, page, pageSize }` (solo activas, `revokedAt = null`)
**And** ningún `SessionDto` MUST exponer `tokenHash`

#### Scenario: Sin permiso
**Given** un usuario sin `admin.view_sessions`
**When** hace `GET /api/admin/sessions`
**Then** MUST responder 403

### REQ-SES-REVOKE-1: Revocar sesiones

El sistema MUST exponer `POST /api/admin/sessions/:id/revoke` y `POST /api/admin/users/:userId/sessions/revoke-all`, ambos protegidos por `requirePerm('admin','revoke_sessions')`.

#### Scenario: Revocar una sesión
**Given** un `POST /api/admin/sessions/:id/revoke` con permiso
**When** se procesa
**Then** MUST marcar `revokedAt` de esa sesión y responder 200/204
**And** el próximo request con el token de esa sesión MUST dar 401

#### Scenario: Revocar todas las de un usuario
**Given** un `POST /api/admin/users/:userId/sessions/revoke-all` con permiso
**When** se procesa
**Then** MUST revocar todas las sesiones activas de ese usuario y responder con la cantidad revocada

#### Scenario: Sin permiso
**Given** un usuario sin `admin.revoke_sessions`
**When** intenta revocar
**Then** MUST responder 403

### REQ-SES-PERMS-1: Permisos nuevos seedados

El sistema MUST agregar `view_sessions` y `revoke_sessions` a `KNOWN_ACTIONS` (módulo `admin`) y seedarlas vía **migración idempotente** (`ON CONFLICT DO NOTHING`), otorgándolas a `super_admin` (y `administrador`).

### REQ-SES-FE-1: Pestaña Sesiones real

El FE MUST reemplazar la pestaña "Sesiones" mock por una vista real que consuma `GET /api/admin/sessions`, con acciones **Forzar logout** (revoca una) y **revoke-all** (por usuario), usando el hook `useConfirm` para confirmar. El mock (`MOCK_ACTIVE_SESSIONS`, historial mock, panel de política) MUST removerse (la política vuelve en SDD #6).

#### Scenario: Lista + revoca
**Given** un admin con permiso abre "Sesiones"
**When** carga
**Then** MUST listar las sesiones activas reales (actor, ip, navegador, inicio, última actividad) con un botón Forzar logout por fila

---

## Appendix: Error Codes / Status

| Scenario | HTTP | `code` |
|----------|------|--------|
| Token sin sesión / revocada | 401 | `UNAUTHORIZED` |
| Ver/revocar sin permiso | 403 | (requirePerm) |
| Sesión inexistente al revocar | 404 | `SESSION_NOT_FOUND` |
