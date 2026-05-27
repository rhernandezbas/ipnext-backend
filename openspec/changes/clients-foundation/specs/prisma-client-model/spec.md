# prisma-client-model Specification

## Purpose

Persistencia del agregado `Client` en Postgres: schema Prisma, enum nativo, tablas editables de catálogo (`ClientType`, `Segment`), migration aplicable y reversible, y seed idempotente.

## Requirements

### Requirement: Client Model

The system MUST define a `Client` model in Prisma with UUID primary key, unique constraints on `email` and `login`, optional `splynxId` for legacy traceability, and foreign keys to `ClientType`, `Segment`, `Partner`, and `Ubicacion`.

#### Scenario: Migration aplicable en entorno limpio

- GIVEN Postgres sin el modelo `Client`
- WHEN `prisma migrate dev --name clients_foundation`
- THEN migration ejecuta sin error; tablas `Client`, `ClientType`, `Segment` existen; enum `ClientStatus` registrado en Postgres

#### Scenario: Constraint unicidad email

- GIVEN cliente existente con `email: a@b.com`
- WHEN INSERT directo en Postgres con mismo email
- THEN constraint `@unique` lanza error Postgres P2002

#### Scenario: Campo splynxId opcional y único

- GIVEN dos clientes
- WHEN asignar mismo `splynxId` a ambos
- THEN constraint `@unique` en `splynxId` lanza error P2002
- AND cliente sin `splynxId` se crea sin error (campo nullable)

---

### Requirement: ClientStatus Enum (Postgres Native)

The system MUST define `ClientStatus` as a Postgres native enum with values `active`, `late`, `blocked`, `inactive`. The enum MUST be generated once in the Prisma schema and exported as TypeScript type — no duplication in application code.

#### Scenario: Status default en creación

- GIVEN payload de creación sin campo `status`
- WHEN INSERT via Prisma
- THEN registro persiste con `status: active` (default declarado en schema)

#### Scenario: Status inválido rechazado por Postgres

- GIVEN enum `ClientStatus` con 4 valores
- WHEN INSERT con `status: "suspended"` (no en enum)
- THEN Postgres rechaza — error de tipo antes de llegar a constraints

---

### Requirement: ClientType Table

The system MUST define a `ClientType` table with UUID PK, `name @unique`, `slug @unique`, `createdAt`, `updatedAt`. This table is editable (not enum) to allow adding types without code deploys.

#### Scenario: Estructura correcta post-migration

- GIVEN migration aplicada
- WHEN `\d "ClientType"` en psql
- THEN columnas: `id uuid PK`, `name varchar unique`, `slug varchar unique`, `createdAt`, `updatedAt`

---

### Requirement: Segment Table

The system MUST define a `Segment` table with the same structure as `ClientType`: UUID PK, `name @unique`, `slug @unique`, `createdAt`, `updatedAt`.

#### Scenario: Estructura correcta post-migration

- GIVEN migration aplicada
- WHEN `\d "Segment"` en psql
- THEN columnas: `id uuid PK`, `name varchar unique`, `slug varchar unique`, `createdAt`, `updatedAt`

---

### Requirement: Idempotent Seed

The system MUST seed `ClientType` (persona, empresa, reseller) and `Segment` (residencial, pyme, corporativo) using `upsert` by unique name. Re-running the seed MUST NOT create duplicates.

#### Scenario: Seed primera ejecución

- GIVEN tablas `ClientType` y `Segment` vacías
- WHEN `prisma db seed`
- THEN `ClientType` tiene 3 registros; `Segment` tiene 3 registros

#### Scenario: Seed idempotente — segunda ejecución

- GIVEN tablas ya pobladas por seed anterior
- WHEN `prisma db seed` segunda vez
- THEN conteo de registros idéntico — no hay duplicados

---

### Requirement: Reversible Migration

The system SHOULD support migration rollback in development environments without data loss beyond the migrated records.

#### Scenario: Reset en dev

- GIVEN migration `clients_foundation` aplicada en dev
- WHEN `prisma migrate reset`
- THEN DB recreada desde cero sin errores de constraint

---

## Invariants

- I-1: El enum `ClientStatus` se define UNA sola vez en `schema.prisma`. No hay literal union `'active' | 'late' | 'blocked' | 'inactive'` en código manual. Verifiable: `rg "'active' \| 'late'" src/` → 0 matches.
- I-2: Migration incluye: creación enum + tablas + FKs + índices en `id`, `email`, `splynxId`. Verifiable: inspección del archivo SQL de migration.
- I-3: FKs a `Partner` y `Ubicacion` son opcionales (`?`) — un cliente puede existir sin partner o ubicación asignada.
