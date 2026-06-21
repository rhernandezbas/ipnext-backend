# zone-management-api Specification

## Purpose
CRUD use cases + HTTP routes for zones, with input validation and DTO mapping. No Prisma entity leaks to routes.

## Requirements

### Requirement: Create a zone
`CreateZone` MUST validate input and persist a zone. A valid polygon has **≥ 3 points**; each point has `lat ∈ [-90,90]`, `lng ∈ [-180,180]`; `name` is non-empty; `color` is a hex string (`#RGB` or `#RRGGBB`).

#### Scenario: Valid zone is created
- GIVEN name "Norte", color "#22c55e", 3 valid points
- WHEN CreateZone executes
- THEN a `ZoneDto` is returned with a generated id and the same points

#### Scenario: Polygon with fewer than 3 points is rejected
- GIVEN points with only 2 entries
- WHEN CreateZone executes
- THEN it throws `InvalidPolygonError` (mapped to HTTP 422)

#### Scenario: Out-of-range coordinate is rejected
- GIVEN a point with `lat = 120`
- WHEN CreateZone executes
- THEN it throws `InvalidPolygonError` (422)

### Requirement: List zones
`ListZones` MUST return all zones as `ZoneDto[]`.

#### Scenario: Lists persisted zones
- GIVEN 2 zones exist
- WHEN ListZones executes
- THEN it returns 2 `ZoneDto`

### Requirement: Update a zone
`UpdateZone` MUST update name/color/points/description of an existing zone, applying the SAME validation as create. Unknown id → `ZoneNotFoundError` (404).

#### Scenario: Updates an existing zone
- GIVEN a zone exists
- WHEN UpdateZone changes its color and points (valid)
- THEN the persisted zone reflects the new values

#### Scenario: Updating a missing zone 404s
- GIVEN no zone with id X
- WHEN UpdateZone(X) executes
- THEN it throws `ZoneNotFoundError` (404)

### Requirement: Delete a zone
`DeleteZone` MUST remove a zone by id. Unknown id → `ZoneNotFoundError` (404).

#### Scenario: Deletes a zone
- GIVEN a zone exists
- WHEN DeleteZone executes
- THEN it no longer appears in ListZones

### Requirement: DTO never exposes the Prisma entity
Routes MUST return `ZoneDto = { id, name, color, points: {lat,lng}[], description: string|null, createdAt: ISO string, updatedAt: ISO string }`.

#### Scenario: Route returns the DTO shape
- GIVEN `GET /api/zones`
- WHEN a zone exists
- THEN each item matches `ZoneDto` exactly (no extra Prisma fields)
