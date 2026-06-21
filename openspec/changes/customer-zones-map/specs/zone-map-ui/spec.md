# zone-map-ui Specification (frontend — coordinated change)

> Lives in repo `ipnext-frontend` (separate worktree, separate commits). Documented here for the cross-repo contract.

## Purpose
Render and edit zones on the customer map using Leaflet + leaflet-draw, gated by `zones.read` / `zones.manage`.

## Requirements

### Requirement: Zones render on the customer map
The customer map MUST fetch `GET /api/zones` (when the user has `zones.read`) and render each zone as a colored polygon.

#### Scenario: Existing zones are drawn
- GIVEN 2 zones exist and the user has `zones.read`
- WHEN the map loads
- THEN both polygons render with their stored color

### Requirement: Editing gated by zones.manage
The draw/edit/delete controls (leaflet-draw) MUST be visible only to users with `zones.manage`. Users with only `zones.read` see zones read-only.

#### Scenario: Reader sees no edit controls
- GIVEN a user with `zones.read` but not `zones.manage`
- WHEN the map loads
- THEN no draw/edit toolbar is shown

### Requirement: Draw a new zone
With `zones.manage`, drawing a polygon and confirming name + color MUST `POST` it and re-render from server state.

#### Scenario: New zone is saved
- GIVEN a manager draws a polygon, names it, picks a color
- WHEN they save
- THEN `POST /api/zones` is called and the new zone appears from the refetched list

### Requirement: Edit and delete
With `zones.manage`, moving a polygon's vertices (`PUT`) or deleting it (`DELETE`) MUST persist via the API and re-render.

#### Scenario: Zone is deleted
- GIVEN a manager deletes a zone
- WHEN confirmed
- THEN `DELETE /api/zones/:id` is called and the polygon disappears
