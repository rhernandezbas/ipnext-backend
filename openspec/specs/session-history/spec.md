# Spec: Session History

**Capability**: `session-history`
**Change**: `sessions-history`
**Summary**: Consulta paginada de sesiones revocadas vía `GET /api/admin/sessions/history`. Read-only, sin side effects. Extiende `SessionRepository` con `findRevoked` de forma aditiva; el endpoint de sesiones activas no se modifica.

---

## Requirements

### REQ-SH-1: Listar sesiones revocadas paginadas

The system MUST return a paginated list of sessions where `revokedAt IS NOT NULL`, ordered by `revokedAt DESC`, when `GET /api/admin/sessions/history` is called by an authenticated admin.

#### Scenario: Happy path — hay sesiones revocadas

**Given** tres sesiones revocadas en DB con `revokedAt` en distintos momentos
**And** un admin autenticado con permiso válido
**When** `GET /api/admin/sessions/history?page=1&pageSize=20`
**Then** MUST responder 200 con `{ data: [...], total: 3, page: 1, pageSize: 20 }`
**And** los items MUST estar ordenados `revokedAt DESC`
**And** cada item MUST contener `id`, `actorLogin`, `ip`, `userAgent`, `loginAt`, `revokedAt`
**And** `tokenHash` MUST NOT aparecer en ningún item

#### Scenario: Historial vacío

**Given** ninguna sesión revocada en DB
**When** `GET /api/admin/sessions/history?page=1&pageSize=20`
**Then** MUST responder 200 con `{ data: [], total: 0, page: 1, pageSize: 20 }`

#### Scenario: Sesiones activas no aparecen en el historial

**Given** dos sesiones activas (`revokedAt: null`) y una revocada
**When** `GET /api/admin/sessions/history?page=1&pageSize=20`
**Then** `data` MUST contener exactamente 1 item
**And** ese item MUST tener `revokedAt` no nulo

---

### REQ-SH-2: Paginación

The system MUST support `page` and `pageSize` query params. `page` defaults to `1`. `pageSize` defaults to `20` and MUST NOT exceed `100`.

#### Scenario: Segunda página

**Given** 25 sesiones revocadas en DB
**When** `GET /api/admin/sessions/history?page=2&pageSize=20`
**Then** MUST responder 200 con `data` de 5 items y `total: 25`

#### Scenario: pageSize por encima del máximo

**Given** un admin autenticado
**When** `GET /api/admin/sessions/history?pageSize=200`
**Then** MUST responder 400 con mensaje indicando que `pageSize` máximo es 100

#### Scenario: Valores default cuando se omiten los params

**Given** 5 sesiones revocadas
**When** `GET /api/admin/sessions/history` (sin params)
**Then** MUST responder 200 con `page: 1` y `pageSize: 20` en la respuesta

---

### REQ-SH-3: tokenHash nunca se expone

The system MUST NOT include `tokenHash` in any response from `GET /api/admin/sessions/history`.

#### Scenario: Campo tokenHash ausente en todos los items

**Given** sesiones revocadas con `tokenHash` poblado en DB
**When** `GET /api/admin/sessions/history`
**Then** ningún item de `data` MUST contener la clave `tokenHash`

---

### REQ-SH-4: Autenticación requerida

The system MUST reject unauthenticated requests to `GET /api/admin/sessions/history`.

#### Scenario: Sin token

**Given** una request sin header Authorization ni cookie de sesión
**When** `GET /api/admin/sessions/history`
**Then** MUST responder 401

---

### REQ-SH-5: Endpoint activo sin modificaciones

The existing `GET /api/admin/sessions` MUST continue returning only active sessions (`revokedAt IS NULL`) without any change in behavior or response shape.

#### Scenario: Endpoint activas no retorna revocadas

**Given** sesiones activas y revocadas en DB
**When** `GET /api/admin/sessions`
**Then** MUST responder solo sesiones donde `revokedAt IS NULL`
**And** la estructura de respuesta MUST ser idéntica a antes del cambio

---

### REQ-SREPO-1: SessionRepository.findRevoked (extensión aditiva)

The `SessionRepository` port MUST expose a `findRevoked(page: number, pageSize: number): Promise<{ data: Session[], total: number }>` method.

#### Scenario: Port satisfecho por InMemory en tests

**Given** un `InMemorySessionRepository` con sesiones mixtas
**When** se llama `findRevoked(1, 20)`
**Then** MUST devolver solo sesiones con `revokedAt !== null`, ordenadas `revokedAt DESC`

#### Scenario: Port satisfecho por Prisma en producción

**Given** `PrismaSessionRepository` conectado a DB de test
**When** se llama `findRevoked(1, 10)` con 15 sesiones revocadas en DB
**Then** MUST devolver 10 items y `total: 15`

---

## Invariants

- I-1: `ListSessionHistory` MUST NOT import from `@infrastructure/*`. Verifiable: `rg "from '@infrastructure" src/application/use-cases/sessions/ListSessionHistory.ts` → 0 matches.
- I-2: `tokenHash` MUST NOT ser mapeado en ningún DTO de sesión. Verifiable: `rg "tokenHash" src/application/dto/session.dto.ts` → 0 matches.
- I-3: El orden `revokedAt DESC` MUST ser responsabilidad del repositorio, no del use case.

## Non-Regression

- NR-1: `GET /api/admin/sessions` sigue devolviendo solo sesiones activas (comportamiento sin cambios).
- NR-2: La suite existente sigue pasando sin modificaciones.
- NR-3: `tsc --noEmit` con 0 errores tras cada commit.
