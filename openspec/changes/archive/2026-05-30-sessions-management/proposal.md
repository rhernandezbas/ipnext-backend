# Proposal — sessions-management (SDD #5)

> Status: PROPOSAL · Artifact store: hybrid · Mode: interactive
> Repos: ipnext-backend (BE) + ipnext-frontend (FE)

## Intent / Why

Hoy la autenticación es **stateless**: `getSession` solo verifica la firma del JWT,
sin tocar la DB. El logout únicamente borra la cookie — el token **sigue válido 8h**
del lado servidor. **No hay forma de revocar una sesión** (ni la propia, ni la de otro
usuario). La pestaña "Sesiones" del panel es 100% mock.

SDD #5 introduce **sesiones reales**: un registro `Session` por login (atado a
`RbacUser`, con `tokenHash`), de modo que se puedan **ver** las sesiones activas y
**revocarlas** (una sola + todas las de un usuario). Es el groundwork de seguridad que
precede a SDD #6 (que hará rotación de tokens, lockout, password policy, etc.).

## Scope

### In
- **BE**: modelo `Session` (FK→RbacUser, `tokenHash`) + puerto `SessionRepository` + adapters Prisma/in-memory.
- **BE**: use cases `CreateSession`, `ListActiveSessions` (paginado), `RevokeSession`, `RevokeAllSessionsForUser`.
- **BE**: **auth stateful** — login crea la Session; `getSession` (tras `jwt.verify`) valida que la Session exista y no esté revocada (1 lookup DB/request); logout revoca la sesión actual.
- **BE**: `lastSeenAt` actualizado **con throttle** (solo si pasaron > 5 min desde el último update) para no escribir en cada request.
- **BE**: endpoints `GET /api/admin/sessions` (paginado), `POST /api/admin/sessions/:id/revoke`, `POST /api/admin/users/:userId/sessions/revoke-all`, protegidos por permisos nuevos.
- **BE**: 2 acciones RBAC nuevas — `admin.view_sessions`, `admin.revoke_sessions` (seed idempotente + grant a super_admin/administrador vía migración).
- **FE**: pestaña "Sesiones" real (`SessionsBody`): lista de sesiones activas (actor, ip, navegador, inicio, última actividad) + **Forzar logout** (single) + revoke-all-for-user. Quitar el mock.

### Out (explícito)
- **Historial de accesos** (logins exitosos/fallidos) → ya lo cubre el AuditEvent de SDD #4 (los `POST /auth/login` se auditan).
- **Política de sesión / enforcement** (idle timeout, límite de sesiones concurrentes, max duration) → **SDD #6 security-hardening**.
- **Refresh tokens / rotación** → SDD #6.
- **Caching del check de sesión** (Redis/in-process) → SDD #6 (perf). MVP acepta 1 query/request.
- **IP geolocation** (city/country) → diferido; se guarda `ip` + `userAgent` crudos.
- Cookie `secure` en dev (prod corre `NODE_ENV=development`) → SDD #6.

## Approach

### Modelo `Session` (Prisma, atado a RbacUser)
```
id          uuid @id
rbacUserId  String   // FK→RbacUser, onDelete Cascade
tokenHash   String @unique   // sha256(jwt) — nunca el token crudo
ip          String?
userAgent   String?
loginAt     DateTime @default(now())
lastSeenAt  DateTime @default(now())
revokedAt   DateTime?        // null = activa
createdAt   DateTime @default(now())
@@index([rbacUserId]) @@index([tokenHash]) @@index([revokedAt])
```
`AdminSession` legacy se deja como está (no se usa; se dropea junto con `Admin` en SDD #6).

### Auth stateful (el cambio central)
- **Login**: tras firmar el JWT, la route crea la Session vía `CreateSession` con `tokenHash = sha256(jwt)`, `ip`/`userAgent` del request. Si falla, no se entrega el token (fail-safe).
- **Cada request**: `getSession` (o el authMiddleware) verifica el JWT y luego `sessionRepo.findByTokenHash(sha256(token))`; si no existe o `revokedAt != null` → **401**. La revocación surte efecto en el **próximo** request (no corta el request en vuelo).
- **`lastSeenAt`**: update con throttle (> 5 min) para evitar escritura por request.
- **Logout**: revoca la sesión actual (por tokenHash) + borra la cookie.
- Inyección hexagonal: el `SessionRepository` se inyecta en la capa de auth (adapter/middleware); el dominio define el puerto. El JWT sigue siendo la fuente de identidad; la Session es la capa de revocación.

### Permisos
Nuevas acciones en `KNOWN_ACTIONS` (rbac.ts): `view_sessions`, `revoke_sessions` (módulo `admin`). Migración idempotente: INSERT de los 2 permisos (`ON CONFLICT DO NOTHING`) + grant a `super_admin` (y `administrador`). Endpoints gateados con `requirePerm('admin','view_sessions'|'revoke_sessions')`.

### FE
`SessionsBody` (nuevo, patrón de los otros *Body): tabla de sesiones activas vía `useActiveSessions` (TanStack Query) + acciones revoke/revoke-all con `useConfirm` (el hook que ya construimos). Se elimina el mock (`MOCK_ACTIVE_SESSIONS`, el historial mock, el panel de política — este último vuelve en #6).

## Phases (tentativo)
1. **BE dominio + datos**: Session entity, SessionRepository port, in-memory adapter, use cases (Create/ListActive/Revoke/RevokeAll), migración (CREATE Session + seed 2 perms + grant). TDD.
2. **BE auth stateful**: login crea Session, getSession valida revocación, logout revoca, lastSeenAt throttle. Tests del flujo (login→request→revoke→401).
3. **BE endpoints**: GET /admin/sessions + revoke + revoke-all, KNOWN_ACTIONS, wire app.ts.
4. **FE**: SessionsBody real + revoke/revoke-all + quitar mock.
5. **Verify + deploy**: tests → BE deploy (migración) → FE deploy → Playwright (login en 2 "sesiones", revocar una, confirmar 401) → archive.

## Risks / decisiones resueltas
- **Perf**: 1 lookup DB por request autenticado (antes 0). Aceptado en MVP; caching → #6. Índice en `tokenHash`.
- **Revocación no corta el request en vuelo** — surte efecto en el próximo. Documentado.
- **`lastSeenAt` write-heavy** → throttle > 5 min.
- **Self vs otros**: `admin.revoke_sessions` permite revocar cualquier sesión (incluida la propia). Granularidad self-only → futuro.
- **Migración**: aditiva (CREATE Session) + seed idempotente de permisos (patrón SDD #3 Phase 2). Sin drops.
- **Tokens viejos pre-#5**: al activar el check stateful, los JWT emitidos antes de #5 no tendrán Session → 401 (re-login). Aceptable (se fuerza re-login una vez al deployar).
