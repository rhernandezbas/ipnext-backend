# Spec: ticket-area-color (#69)

## Requirement: Area catalog carries an editable hex color
The `TicketAreaCatalog` SHALL have a `color` field (hex, e.g. `#6366f1`).

### Scenario: create an area with a color
- WHEN POST `/api/tickets/areas` with `{ name, color }` and a valid 6-digit hex
- THEN 201 with `{ id, name, color }`

### Scenario: reject a non-hex color
- WHEN POST/PUT with `color` that is not `^#[0-9a-fA-F]{6}$`
- THEN 400 `VALIDATION_ERROR`

### Scenario: update only the color
- WHEN PUT `/api/tickets/areas/:id` with `{ color }`
- THEN 200 with the area name unchanged and the new color

## Requirement: Ticket DTO exposes the area color inline
The ticket list and detail DTOs SHALL include `areaColor` (JOIN-derived from `TicketAreaCatalog.color`).

### Scenario: ticket with an area
- WHEN a ticket has `areaId`
- THEN the DTO has `areaColor` = the catalog color and `areaName` = the catalog name

### Scenario: ticket without an area
- WHEN a ticket has no `areaId`
- THEN `areaId`, `areaName`, and `areaColor` are all null

## Requirement: Migration adds color + seeds the 3 default areas
A migration (timestamp ≥ 20260709000000) SHALL add the `color` column (NOT NULL, default `#6366f1`) and set distinct LLAMATIVE colors for the 3 seed areas by name, idempotently.

- Soporte → `#6366f1` (índigo)
- Administración → `#f59e0b` (ámbar)
- Facturación → `#10b981` (esmeralda)

## Requirement: Tickets list shows the Área column as a colored pill
The tickets list SHALL render an "Área" column (visible by default) as a pill with the catalog color and legible (auto-contrasted) text; '—' when the ticket has no area. No hardcoded area names — catalog-driven.

### Scenario: column reaches the table via the real path
- WHEN the page passes `visibleColumnKeys` derived from `ALL_TICKET_COLUMNS`
- THEN the "Área" column renders (catalog key `areaName` === table key `areaName`, lesson #48)

## Requirement: Area ABM edits the color
The area catalog ABM SHALL have a color input (native picker) and show a color swatch per row. New areas default to `#6366f1`.
