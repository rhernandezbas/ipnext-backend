# zone-rbac Specification

## Purpose
A new `zones` RBAC module with `read` and `manage` actions, gating the zone routes on both layers.

## Requirements

### Requirement: zones module and permissions exist
The system MUST register a `zones` RbacModule and the permissions `zones.read` and `zones.manage`, seeded **idempotently** via migration (`ON CONFLICT ... DO NOTHING`). `'zones'` MUST be added to `RBAC_MODULES` in `domain/entities/rbac.ts`.

#### Scenario: Permissions are seeded
- GIVEN the migration runs
- WHEN `/auth/me` resolves a super_admin
- THEN `zones.read` and `zones.manage` are available (super_admin via `*`)

### Requirement: Read routes require zones.read
`GET /api/zones` and `GET /api/zones/:id` MUST require `zones.read`.

#### Scenario: Reader without permission is blocked
- GIVEN a user without `zones.read`
- WHEN `GET /api/zones`
- THEN 403

### Requirement: Write routes require zones.manage
`POST` / `PUT` / `DELETE /api/zones*` MUST require `zones.manage`.

#### Scenario: Non-manager cannot create
- GIVEN a user with `zones.read` but not `zones.manage`
- WHEN `POST /api/zones`
- THEN 403

#### Scenario: Manager can create
- GIVEN a user with `zones.manage`
- WHEN `POST /api/zones` with a valid polygon
- THEN 201 with the `ZoneDto`
