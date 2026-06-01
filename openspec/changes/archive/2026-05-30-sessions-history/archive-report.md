# Archive Report — sessions-history (SDD #6b)

**Archived: 2026-05-30** · Verdict: PASS · Shipped to production.

## What shipped

Consulta paginada de sesiones revocadas. Nuevo endpoint `GET /api/admin/sessions/history` que retorna sesiones con `revokedAt IS NOT NULL`, ordenadas `revokedAt DESC`, con paginación (`page`/`pageSize`, máximo 100). El endpoint existente `GET /api/admin/sessions` (activas) no fue modificado. El campo `tokenHash` nunca se expone en ninguna respuesta.

## Implementation

- `SessionRepository` port extendido con `findRevoked(page, pageSize): Promise<SessionPage>` (aditivo, sin romper contratos existentes).
- Use case `ListSessionHistory` en `src/application/use-cases/sessions/` — importa solo de `@domain/*` y `@application/*`.
- `PrismaSessionRepository.findRevoked` con `WHERE revokedAt IS NOT NULL ORDER BY revokedAt DESC` usando `Promise.all([findMany, count])`.
- `InMemorySessionRepository.findRevoked` para tests — filter + sort + slice.
- Router `GET /history` montado al TOP de `createSessionsRouter` (antes de `/:id/*`) para evitar conflictos de ruta. Validación `pageSize > 100` → 400 en el handler.
- Wiring en `app.ts`: `listSessionHistory` instanciado y pasado como segundo argumento.

## Test coverage

- 6+ unit tests (`ListSessionHistory.test.ts`) con `InMemorySessionRepository`.
- 4+ integration tests (`sessions.history.integration.test.ts`) con supertest.
- Non-regression: `GET /api/admin/sessions` verificado.

## No migration required

El campo `revokedAt` ya existía en el modelo `Session` (introducido en sessions-management). Un índice en `revokedAt` está diferido como optimización separada.

## Spec synced

Canonical capability spec → `openspec/specs/session-history/spec.md`.
