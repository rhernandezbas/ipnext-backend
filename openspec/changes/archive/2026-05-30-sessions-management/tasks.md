# Tasks: sessions-management

> TDD estricto: tests RED → impl GREEN → refactor por fase. BE=ipnext-backend, FE=ipnext-frontend.
> Commits independientes por repo, push=PROD (confirmar cada uno). No `npm run build`.

## Phase 1 — BE: dominio + datos (aditivo)

### T-1: Dominio
- [ ] `src/domain/entities/session.ts` — `Session`
- [ ] `src/domain/ports/SessionRepository.ts` — create / findByTokenHash / findById / listActive (paginado) / revoke / revokeAllForUser / touch

### T-2: Tests RED
- [ ] `src/__tests__/application/sessions/SessionUseCases.test.ts` (in-memory): ListActiveSessions (paginación + solo activas + DTO sin tokenHash), RevokeSession (404 unknown), RevokeAllSessionsForUser (count + solo activas), CreateSession
- [ ] `src/__tests__/infrastructure/adapters/_shared/sessionContractTests.ts` + runner in-memory (create/findByTokenHash/revoke/listActive)

### T-3: Application + in-memory (GREEN)
- [ ] `src/application/use-cases/sessions/CreateSession.ts`, `ListActiveSessions.ts`, `RevokeSession.ts`, `RevokeAllSessionsForUser.ts`
- [ ] `src/application/dto/session.dto.ts` — `SessionDto` (sin `tokenHash`, con `actorLogin`) + mapper
- [ ] `src/infrastructure/adapters/in-memory/InMemorySessionRepository.ts` (con seed/touch-throttle)

### T-4: schema.prisma + migración
- [ ] Agregar `model Session` (rbacUserId FK Cascade, tokenHash unique, ip?, userAgent?, loginAt, lastSeenAt, revokedAt?, createdAt + índices) + relación inversa en `RbacUser`
- [ ] Agregar `view_sessions`, `revoke_sessions` a `KNOWN_ACTIONS` (rbac.ts, módulo admin)
- [ ] Generar `prisma migrate diff` para el CREATE; armar migración `<ts>_create_session` = CREATE Session + seed idempotente de los 2 permisos + grant super_admin (patrón SDD #3 Phase 2). Timestamp posterior a las migraciones existentes.

### T-5: Cierre Phase 1
- [ ] `npx jest` (sessions) verde + `npx tsc --noEmit` limpio
- [ ] Commit BE: `feat(sessions): Session model + ports + in-memory + use cases (Phase 1)`

## Phase 2 — BE: auth stateful

### T-6: Tests RED (flujo de auth)
- [ ] `src/__tests__/infrastructure/sessionAuth.test.ts` (supertest, fake authProvider + in-memory sessionRepo): sesión activa → 200; revocada → 401; JWT válido sin sesión → 401; lastSeenAt NO se escribe dentro de los 5 min
- [ ] Test: login crea una Session; logout la revoca; request post-logout → 401

### T-7: Integración (GREEN)
- [ ] `authMiddleware` recibe `SessionRepository`; tras `getSession`, valida `findByTokenHash(sha256(token))` + revocado → 401; `touch` con throttle >5min
- [ ] Login route: `CreateSession` con `sha256(cookieValue)` + ip/userAgent ANTES de setear la cookie (fail-safe)
- [ ] Logout route: revocar sesión actual (por tokenHash) + limpiar cookie
- [ ] helper `sha256(token)` compartido

### T-8: Cierre Phase 2
- [ ] `npx jest` verde + `tsc` limpio
- [ ] Commit BE: `feat(sessions): stateful auth — login crea, logout revoca, request valida (Phase 2)`

## Phase 3 — BE: endpoints

### T-9: Tests RED (endpoints)
- [ ] `src/__tests__/infrastructure/http/routes/sessions.routes.test.ts` (supertest): GET /admin/sessions (paginado, DTO sin tokenHash, 403 sin permiso); POST /:id/revoke (200, 404, 403); POST /users/:userId/sessions/revoke-all (200, 403)

### T-10: Routes + wiring (GREEN)
- [ ] `src/infrastructure/http/routes/sessions.routes.ts` — GET / + POST /:id/revoke; ruta revoke-all (puede ir bajo /admin/users/:userId/sessions/revoke-all)
- [ ] Wire en `app.ts`: `sessionRepo` module-level inyectado en authMiddleware + login/logout + routers; montar con `requirePerm('admin','view_sessions'|'revoke_sessions')`

### T-11: Cierre Phase 3
- [ ] `npx jest` verde + `tsc` limpio
- [ ] Commit BE: `feat(sessions): GET /admin/sessions + revoke + revoke-all + permisos (Phase 3)`

## Phase 4 — FE: pestaña Sesiones real

### T-12: Tests RED (Vitest)
- [ ] `useActiveSessions` hook test (mock api, paginación)
- [ ] `SessionsBody` test: render de filas + Forzar logout dispara confirm + llama api; empty state

### T-13: Tipos + api + hook (GREEN)
- [ ] `src/types/session.ts` — `SessionDto`
- [ ] `src/api/sessions.api.ts` — list / revoke / revokeAllForUser
- [ ] `src/hooks/useSessions.ts` — `useActiveSessions` + mutations (invalidan la query)

### T-14: UI
- [ ] `src/pages/system/admin/SessionsBody.tsx` (+ .module.css) — tabla activa (actor, ip, navegador, inicio, última actividad) + Forzar logout (confirm danger) + revoke-all por usuario
- [ ] `AdminPage.tsx` tab 'sesiones' → `<SessionsBody/>`; quitar `MOCK_ACTIVE_SESSIONS`, historial mock y panel de política (vuelve en #6)

### T-15: Cierre Phase 4
- [ ] `npx vitest run` verde
- [ ] Commit FE: `feat(admin): pestaña Sesiones real sobre Session API (Phase 4)`

## Phase 5 — Verify + deploy

### T-16: Verify
- [ ] Suite completa BE (`npx jest`) + FE (`npx vitest run`) verde + `tsc`
- [ ] `/sdd-verify` contra spec

### T-17: Deploy (gates de push, uno por uno)
- [ ] Rebase sobre origin/main (chequear colisión de timestamp de migración). Push BE → `gh run watch` (incluye migración + seed perms). Confirmar step de migraciones verde.
- [ ] Push FE → `gh run watch`
- [ ] Playwright smoke en prod: loguear, abrir Sesiones, ver la sesión activa; revocar-all-for-user de un usuario de prueba o forzar logout de una sesión y confirmar que un request posterior con ese token da 401. **OJO**: el deploy invalida los JWT pre-#5 (re-login forzado) — esperado.

### T-18: Archive
- [ ] `/sdd-archive` — sync `sessions` spec → openspec/specs/sessions/, mover change a archive/
