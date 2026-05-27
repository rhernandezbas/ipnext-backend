# client-crud Specification

## Purpose

CRUD completo del agregado `Client` con persistencia Postgres, validación zod en boundary HTTP/application y reglas de dominio (unicidad, transiciones de estado, restricción de borrado con dependencias).

## Requirements

### Requirement: Create Client

The system MUST persist a new `Client` in Postgres when receiving a valid payload, returning a 201 with the entity completa including UUID assigned by the DB.

#### Scenario: Happy path — payload válido con email único

- GIVEN un payload con email único, firstName, lastName y campos opcionales válidos
- WHEN POST /api/clients
- THEN 201 + entity con `id` UUID, `status` default `active`, `createdAt`

#### Scenario: Email duplicado

- GIVEN un `Client` ya existente con email `a@b.com`
- WHEN POST /api/clients con email `a@b.com`
- THEN 409 Conflict con mensaje de unicidad

#### Scenario: Payload inválido (zod)

- GIVEN payload con email mal formado o `status` fuera del enum
- WHEN POST /api/clients
- THEN 400 con detalle de errores zod (field + message)

---

### Requirement: Update Client

The system MUST apply partial updates to an existing `Client` and return the updated entity. The field `splynxId` MUST NOT be mutated post-creación.

#### Scenario: Actualización parcial válida

- GIVEN cliente existente con id `{uuid}`
- WHEN PATCH /api/clients/{uuid} con payload parcial válido (ej: `{ "phone": "099..." }`)
- THEN 200 + entity actualizada con campo modificado

#### Scenario: Cliente no existe

- GIVEN id `{uuid}` inexistente
- WHEN PATCH /api/clients/{uuid}
- THEN 404 Not Found

#### Scenario: Intento de mutar splynxId

- GIVEN cliente existente con `splynxId` seteado
- WHEN PATCH /api/clients/{uuid} con `{ "splynxId": "otro-valor" }`
- THEN 400 con mensaje "splynxId es inmutable post-creación"

---

### Requirement: Delete Client

The system MUST delete a `Client` only if it has no active services. Clients with active services MUST NOT be deleted.

#### Scenario: Borrado exitoso — sin servicios activos

- GIVEN cliente existente sin servicios activos asociados
- WHEN DELETE /api/clients/{uuid}
- THEN 204 No Content

#### Scenario: Borrado bloqueado — con servicios activos

- GIVEN cliente con al menos un servicio activo
- WHEN DELETE /api/clients/{uuid}
- THEN 409 Conflict con mensaje de regla de dominio

#### Scenario: Cliente no existe

- GIVEN id `{uuid}` inexistente
- WHEN DELETE /api/clients/{uuid}
- THEN 404 Not Found

---

### Requirement: Change Client Status

The system MUST update the `status` field of a `Client` to one of the valid enum values (`active`, `late`, `blocked`, `inactive`).

#### Scenario: Transición válida

- GIVEN cliente existente con `status: active`
- WHEN PATCH /api/clients/{uuid}/status con `{ "status": "blocked" }`
- THEN 200 + entity con `status: blocked`

#### Scenario: Status fuera del enum

- GIVEN cliente existente
- WHEN PATCH /api/clients/{uuid}/status con `{ "status": "suspended" }`
- THEN 400 con detalle zod — valor no válido para `ClientStatus`

---

### Requirement: List Clients

The system MUST return a paginated list of clients with optional filters. Response MUST include `{ data, total, page, limit }`.

#### Scenario: Sin filtros — respuesta paginada

- GIVEN clientes en DB
- WHEN GET /api/clients?page=1&limit=20
- THEN 200 con `{ data: [...], total: N, page: 1, limit: 20 }`

#### Scenario: Filtro por status

- GIVEN clientes con distintos status
- WHEN GET /api/clients?status=active
- THEN 200 con solo clientes cuyo `status === "active"`

#### Scenario: Filtros relacionales

- GIVEN clientes con `partnerId`, `clientTypeId`, `segmentId`, `ubicacionId` distintos
- WHEN GET /api/clients?partnerId={id}&clientTypeId={id}
- THEN 200 con solo clientes que satisfacen TODOS los filtros aplicados

#### Scenario: Búsqueda por texto libre

- GIVEN clientes con distintos nombre/email/login
- WHEN GET /api/clients?search=texto
- THEN 200 con clientes cuyo nombre, email o login contiene `texto` (case-insensitive)

---

### Requirement: Get Client Detail

The system MUST return the complete entity of a single `Client` by UUID.

#### Scenario: Cliente encontrado

- GIVEN id `{uuid}` existente
- WHEN GET /api/clients/{uuid}
- THEN 200 + entity completa con todos los campos

#### Scenario: Cliente no encontrado

- GIVEN id `{uuid}` inexistente
- WHEN GET /api/clients/{uuid}
- THEN 404 Not Found

---

## Invariants

- I-1: Use cases en `src/application/use-cases/` MUST NOT import from `@infrastructure/*`. Verifiable: `rg "from '@infrastructure" src/application/use-cases/` → 0 matches.
- I-2: zod schemas MUST NOT reside in `src/domain/`. Verifiable: `rg "from 'zod'" src/domain/` → 0 matches.
- I-3: `splynxId` es inmutable post-creación. Verifiable: escenario de test unitario en `UpdateClient`.

## Non-Regression

- NR-1: Los 322 tests existentes siguen pasando tras cada commit.
- NR-2: `tsc --noEmit` 0 errores tras cada commit.
- NR-3: Endpoints no-client (auth, dashboard, tickets) responden idéntico.
