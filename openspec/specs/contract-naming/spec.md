# Contract Naming Specification

**Capability**: `contract-naming` (NEW)
**Change**: `contract-services-model` (#43)
**Summary**: `Contract.name String?` — manual-only identifier. `PATCH /api/contracts/:id { name }` persists to DB (replaces in-memory stub). GR sync NEVER overwrites `name`. Display semantics: `name ?? plan`. Address semantics documented and pinned.

---

## Requirements

### Requirement CN-1: Contract has nullable name field

The system MUST add `name String?` to the `Contract` model (Prisma + domain entity + DTO).

#### Scenario CN-1.1: Additive migration does not break existing contracts

- GIVEN existing `Contract` rows in the database
- WHEN the migration adding `name String?` to `Contract` is applied
- THEN all existing rows MUST remain with `name = NULL` and no data loss occurs

#### Scenario CN-1.2: GET contracts exposes name field (null for legacy contracts)

- GIVEN a contract synced from GR (no manual name set)
- WHEN `GET /api/clients/:id/contracts` is called
- THEN the contract object MUST include `name: null`

---

### Requirement CN-2: PATCH contract name persists to database

The system MUST expose `PATCH /api/contracts/:id` accepting `{ name?: string | null }` requiring `clients.write`. This endpoint MUST write to the database (NOT to `contractsOverrideStore` in-memory stub).

#### Scenario CN-2.1: Set name on a contract

- GIVEN contract with `id = C` exists and has `name = null`
- WHEN `PATCH /api/contracts/C` with `{ name: "Fibra Casa" }` and a `clients.write` token
- THEN the response MUST be HTTP 200 with `{ id: C, name: "Fibra Casa" }`
- AND a subsequent `GET /api/clients/:clientId/contracts` MUST return `name: "Fibra Casa"` (persisted)

#### Scenario CN-2.2: Clear name by sending empty string or null

- GIVEN contract with `id = C` has `name = "Fibra Casa"`
- WHEN `PATCH /api/contracts/C` with `{ name: "" }` is called
- THEN `name` MUST be stored as `null` (empty string normalized to null)
- AND a subsequent GET MUST return `name: null`

#### Scenario CN-2.3: 404 for non-existent contract

- GIVEN no contract with `id = X` exists
- WHEN `PATCH /api/contracts/X` with `{ name: "Test" }` is called
- THEN the response MUST be HTTP 404 with `{ code: "CONTRACT_NOT_FOUND" }`

#### Scenario CN-2.4: 403 without clients.write

- GIVEN a token with only `clients.read`
- WHEN `PATCH /api/contracts/C` with `{ name: "Test" }` is called
- THEN the response MUST be HTTP 403

---

### Requirement CN-3: GR sync never overwrites name

The system MUST NOT include `name` in the data object passed to Prisma inside `PrismaClientMirrorRepository.upsertContract`.

#### Scenario CN-3.1: Sync preserves manually-set name

- GIVEN contract C has `name = "Antena Trabajo"` set manually
- WHEN `upsertContract` runs for that contract (GR sync)
- THEN `Contract.name` MUST remain `"Antena Trabajo"` after the upsert
- AND the sync MUST NOT set `name` to `null` or to any GR-derived value

#### Scenario CN-3.2: Sync on a contract with no name leaves it null

- GIVEN contract C has `name = null`
- WHEN `upsertContract` runs for that contract
- THEN `Contract.name` MUST remain `null` (sync does not set it)

---

### Requirement CN-4: Address semantics — GR wins

The system MUST document and maintain the existing behavior: `Contract.address/lat/lng` is always written by `upsertContract` from GR data.

#### Scenario CN-4.1: Sync updates address on every run

- GIVEN contract C has `address = "Calle 1234"` (set manually or previously)
- WHEN `upsertContract` runs with GR data containing `domicilio = "Av. Corrientes 500"`
- THEN `Contract.address` MUST be `"Av. Corrientes 500"` after the upsert (GR wins)

#### Scenario CN-4.2: Client address is billing; contract address is installation

- GIVEN client with `address = "Av. Santa Fe 100"` and contract with `address = "Av. Corrientes 500"`
- WHEN `GET /api/clients/:id` is called
- THEN `client.address` MUST be `"Av. Santa Fe 100"` (billing)
- AND `GET /api/clients/:id/contracts` MUST return `contract.address = "Av. Corrientes 500"` (installation, GR-sourced)

---

## Constraints

- `Contract.name` MUST be `String?` (nullable) — not required, not unique
- Empty string input (`""`) for `name` MUST be normalized to `null` at the use-case layer
- `upsertContract` MUST NOT include `name` in its Prisma `data` object (same guard pattern as `technology`)
- `PATCH /api/contracts/:id` MUST use a real DB write — the existing `contractsOverrideStore` in-memory stub is NOT acceptable
- Display semantics (`name ?? plan`) is a UI concern handled in #42 — this spec only covers the data layer
- All endpoints MUST require authentication AND the stated permission (two-layer guard)
- Use cases MUST depend on port interfaces only; no direct Prisma imports

---

## Error Code Reference

| Scenario | HTTP | `code` |
|----------|------|--------|
| Contract not found | 404 | `CONTRACT_NOT_FOUND` |
| No permission | 403 | (standard auth error) |
