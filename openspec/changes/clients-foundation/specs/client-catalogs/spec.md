# client-catalogs Specification

## Purpose

Endpoint agregado y endpoints individuales para obtener los catálogos necesarios para formularios de admin: tipos de cliente, segmentos, statuses del enum, planes, partners y ubicaciones.

## Requirements

### Requirement: Aggregated Catalogs Endpoint

The system MUST expose `GET /api/clients/catalogs` returning a single aggregated response with all catalog data needed for the client creation/edit form.

#### Scenario: Respuesta correcta con datos en DB

- GIVEN tipos, segmentos, partners y ubicaciones existentes en Postgres
- WHEN GET /api/clients/catalogs
- THEN 200 con estructura:
  ```json
  {
    "types": [{ "id": "uuid", "name": "string", "slug": "string" }],
    "segments": [{ "id": "uuid", "name": "string", "slug": "string" }],
    "statuses": ["active", "late", "blocked", "inactive"],
    "plans": [...],
    "partners": [...],
    "locations": [...]
  }
  ```

#### Scenario: Sin datos en catálogos opcionales

- GIVEN DB sin plans, partners o locations
- WHEN GET /api/clients/catalogs
- THEN 200 con `plans: []`, `partners: []`, `locations: []` — no falla por arrays vacíos
- AND `statuses` siempre contiene los 4 valores del enum (estático, no DB)

---

### Requirement: List Client Types

The system MUST expose `GET /api/client-types` returning all `ClientType` records ordered alphabetically by name.

#### Scenario: Tipos disponibles

- GIVEN ClientType records en DB (ej: empresa, persona, reseller)
- WHEN GET /api/client-types
- THEN 200 con array `[{ id, name, slug }]` ordenado por `name` ASC

#### Scenario: Sin tipos en DB

- GIVEN tabla `ClientType` vacía
- WHEN GET /api/client-types
- THEN 200 con `[]`

---

### Requirement: List Segments

The system MUST expose `GET /api/segments` returning all `Segment` records ordered alphabetically by name.

#### Scenario: Segmentos disponibles

- GIVEN Segment records en DB (ej: corporativo, pyme, residencial)
- WHEN GET /api/segments
- THEN 200 con array `[{ id, name, slug }]` ordenado por `name` ASC

#### Scenario: Sin segmentos en DB

- GIVEN tabla `Segment` vacía
- WHEN GET /api/segments
- THEN 200 con `[]`

---

### Requirement: ClientType and Segment CRUD — OUT OF SCOPE

The system SHALL NOT expose create/update/delete endpoints for `ClientType` or `Segment` in this change. These are read-only catalogs initialized via seed; admin CRUD is deferred to a future change.

#### Scenario: No existen endpoints de escritura para catálogos

- GIVEN this change is deployed
- WHEN POST/PATCH/DELETE /api/client-types or /api/segments
- THEN 404 (rutas no registradas)

---

## Invariants

- I-1: El array `statuses` en `/catalogs` MUST be hardcoded from the `ClientStatus` enum export — never queried from DB.
- I-2: `GET /api/clients/catalogs` MUST be registered BEFORE `GET /api/clients/:id` to avoid route shadowing. Verifiable: orden de registro en `clients.routes.ts`.
