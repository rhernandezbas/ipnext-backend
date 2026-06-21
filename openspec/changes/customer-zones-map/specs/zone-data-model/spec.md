# zone-data-model Specification

## Purpose
Persisted schema for visual zones: a polygon (ordered array of lat/lng points), a name, and a display color. Additive — zero changes to existing tables.

## Requirements

### Requirement: Zone table
The system MUST persist a `Zone` table with `id` (UUID PK), `name` (varchar NOT NULL), `color` (varchar NOT NULL), `points` (jsonb NOT NULL), `description` (varchar NULLABLE), `createdAt` (timestamptz default now), `updatedAt` (timestamptz). `points` stores an ordered array of `{ lat, lng }` vertices.

#### Scenario: Zone persists its polygon
- GIVEN a CreateZone with name "Centro", color "#2563eb", and 4 points
- WHEN it is saved
- THEN the row stores the 4 points, in order, in the `points` jsonb column

### Requirement: Domain entity decoupled from Prisma
The `Zone` domain entity MUST NOT expose Prisma types. `points` is `ZonePoint[]` where `ZonePoint = { lat: number; lng: number }`.

#### Scenario: Repository returns a domain entity
- GIVEN a persisted zone
- WHEN `findById` is called
- THEN it returns a `Zone` domain entity (not a Prisma model), with `points` as `ZonePoint[]`
