# Proposal: sessions-history

## Intent

Exponer el historial de sesiones revocadas vía un nuevo endpoint paginado, manteniendo la separación semántica clara entre sesiones **activas** (revokedAt IS NULL) y **revocadas** (revokedAt IS NOT NULL). El campo `revokedAt` ya existe en el modelo `Session`; no se requiere migración. El endpoint existente `GET /api/admin/sessions` MUST seguir devolviendo solo activas — la historia es un recurso nuevo y ortogonal.

## Scope

### In Scope
- Nuevo use case `ListSessionHistory`: lista sesiones con `revokedAt IS NOT NULL`, orden `revokedAt DESC`, paginado con `page` / `pageSize`.
- Extensión del port `SessionRepository` con método `findRevoked(page, pageSize): Promise<{ data: Session[], total: number }>`.
- Implementación en `PrismaSessionRepository` del método nuevo.
- Implementación in-memory `InMemorySessionRepository` del método nuevo (para tests).
- Nuevo endpoint `GET /api/admin/sessions/history` con query params `page` (default 1) y `pageSize` (default 20, max 100).
- DTO de respuesta idéntico al de `ListActiveSessions` más el campo `revokedAt: string (ISO 8601)`. El campo `tokenHash` MUST NOT exponerse.
- Tests unitarios del use case (TDD, InMemory).
- Tests de integración del endpoint vía supertest.

### Out of Scope
- Cambios en el endpoint `GET /api/admin/sessions` (activas — sin modificaciones).
- Purga/limpieza automática de sesiones revocadas.
- Filtrado por actor, IP u otros campos (puede implementarse como extensión futura).
- Agregado de índice en `revokedAt` (decisión de infra, fuera del alcance funcional; se puede agregar en una migration de optimización separada).

## Capabilities

### New Capabilities
- `session-history`: Consulta paginada de sesiones revocadas. Read-only, sin side effects.

### Modified Capabilities
- `session-management` (port + adapters): extensión aditiva de la interfaz `SessionRepository` con `findRevoked`. Los llamadores existentes no se ven afectados.

## Approach

**2 commits atómicos**:

1. **Commit 1 — Domain + Application (TDD)**: extensión del port `SessionRepository`, `InMemorySessionRepository`, use case `ListSessionHistory` con tests (rojo → verde).
2. **Commit 2 — Infrastructure + HTTP**: `PrismaSessionRepository.findRevoked`, nuevo router/endpoint, wiring en `app.ts`, tests de integración.

El endpoint existente de activas no se toca — cambios aditivos puros.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/domain/ports/SessionRepository.ts` | Modified | Agrega método `findRevoked` |
| `src/application/use-cases/sessions/ListSessionHistory.ts` | New | Use case nuevo |
| `src/application/dto/session.dto.ts` | Modified | Agrega campo `revokedAt` al DTO (nullable en activas) |
| `src/infrastructure/adapters/prisma/PrismaSessionRepository.ts` | Modified | Implementa `findRevoked` |
| `src/infrastructure/adapters/in-memory/InMemorySessionRepository.ts` | Modified | Implementa `findRevoked` |
| `src/infrastructure/http/routes/sessions.routes.ts` | Modified | Agrega `GET /history` |
| `src/infrastructure/http/app.ts` | Modified | Wiring del nuevo use case |
| `src/__tests__/application/sessions/ListSessionHistory.test.ts` | New | Tests unitarios |
| `src/__tests__/infrastructure/sessions.history.integration.test.ts` | New | Tests de integración |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Sesiones revocadas ilimitadas afectan performance | Med | Paginación obligatoria (pageSize max 100). Índice en `revokedAt` recomendado en migration separada |
| `revokedAt` expuesto en DTO de activas → cambio de contrato | Low | Marcar `revokedAt?: string | null` en el DTO base; el endpoint de activas siempre devuelve `null` — compatible |
| Test count regression | Low | Solo adiciones; suite existente no se modifica |

## Rollback Plan

- `git revert` de commit 2 (HTTP) deja el dominio intacto.
- `git revert` de commit 1 revierte la extensión del port (los adapters existentes no rompen si se elimina el método antes de que lo llamen).
- Sin migración de DB → rollback inmediato, sin estado a revertir.

## Success Criteria

- [ ] `GET /api/admin/sessions/history` devuelve `{ data: SessionHistoryDTO[], total, page, pageSize }` con sesiones `revokedAt IS NOT NULL`, orden `revokedAt DESC`.
- [ ] `GET /api/admin/sessions` no se modifica (solo activas).
- [ ] `tokenHash` nunca aparece en ninguna respuesta.
- [ ] `revokedAt` aparece en los items del historial como ISO 8601.
- [ ] Paginación funciona: `?page=2&pageSize=10` devuelve el slice correcto.
- [ ] Tests nuevos: mínimo 6 unitarios + 4 de integración.
- [ ] `tsc --noEmit` con 0 errores.
- [ ] Suite existente sin regresiones.
