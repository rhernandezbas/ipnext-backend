<!-- generated from engram topic_key: sdd/customer-zones-map/proposal -->
## Intent
Permitir que un operador con permiso **dibuje, edite y borre ZONAS** (polígonos) sobre el mapa de clientes (Leaflet), **persistidas en el backend**, gateadas por permisos granulares `zones.read` / `zones.manage`. Las zonas son delimitaciones **VISUALES** (nombre + color + polígono) — sin lógica de asignación de clientes, sin point-in-polygon, sin PostGIS.

## Why
- El "mapa de clientes" actual (`/admin/customers/map`, FE `CustomerMapPage.tsx`) es un **STUB**: 12 clientes hardcodeados, CERO persistencia, sin integración con la API.
- NO existe modelo de zonas en ningún lado (ni BE ni FE). Lo de "zonas" hoy son 3 círculos hardcodeados en scheduling.
- El usuario necesita delimitar áreas (cobertura / sectores) y que queden **GUARDADAS y compartidas** entre usuarios, no dibujos efímeros en el browser.
- **Decisiones del usuario (2026-06-21):** Leaflet (gratis, ya instalado — **NO** Google Maps de pago); zonas **SOLO visuales**; **NO** conectar clientes reales en este cambio.

## Proposed change (aditivo, bajo riesgo)
**BACKEND (repo `ipnext-backend`):**
1. Prisma model `Zone` (id, name, color, points Json, description?, createdAt, updatedAt). Migración aditiva (CREATE TABLE).
2. Dominio: entidad `Zone` + `ZonePoint` + errores (`ZoneNotFoundError`, `InvalidPolygonError`).
3. Port `ZoneRepository` + adapters `PrismaZoneRepository` / `InMemoryZoneRepository`.
4. Use cases: `CreateZone`, `ListZones`, `GetZone`, `UpdateZone`, `DeleteZone` (un caso por archivo).
5. DTO `ZoneDto` (nunca exponer entidad Prisma cruda).
6. HTTP `zones.routes.ts`: `GET /` (read), `POST /` (manage), `GET /:id` (read), `PUT /:id` (manage), `DELETE /:id` (manage). Wiring en `app.ts`.
7. RBAC: módulo `zones` + acciones `read`/`manage` (reusa `KNOWN_ACTIONS`). Migración idempotente: RbacModule + RbacPermission + grants. Guard en **cada** ruta.

**FRONTEND (repo `ipnext-frontend` — change COORDINADO, commits separados):**
8. Instalar `leaflet-draw` + `@types/leaflet-draw`.
9. En `CustomerMapPage`: capa de zonas (fetch `GET /api/zones`, render polígonos por color). Modo edición (toggle gateado por `zones.manage`) con controles leaflet-draw (dibujar/editar/borrar) + form nombre/color. View-only para `zones.read`.
10. Hook `useZones` (TanStack Query) + mutations create/update/delete. Permisos con `<Can>` / `RequirePermission`.

## Rollback
`DROP TABLE "Zone"` + quitar el módulo `zones` del RBAC (o dejarlo huérfano, inofensivo). FE: quitar la capa de zonas; el mapa vuelve al stub. **Cero impacto en datos existentes** (todo aditivo).

## Out of scope (explícito)
- Conectar clientes reales al mapa (`Contract.lat/lng` existe pero NO se expone — cambio aparte).
- Point-in-polygon / asignación de clientes a zonas / cobertura-factibilidad.
- PostGIS / geometría espacial nativa.
- Google Maps / Mapbox (descartado por costo; Leaflet gratis).

## Cross-reference
- FE coordinado: `ipnext-frontend` change `customer-zones-map-ui` (commits separados, mismo feature).
- Pattern RBAC: `openspec/changes/archive/2026-05-28-auth-rbac-foundation` + migración `20260730000000_pppoe_rbac_permissions`.
- ⚠️ **Convención FE**: el stub `CustomerMapPage` usa clases **Tailwind**, pero el proyecto declara CSS Modules + tokens `var(--color-*)` (NO Tailwind). Resolver en la fase FE (¿Tailwind configurado o clases muertas?) — seguir la convención REAL + skill `ui-ux-pro-max`/`impeccable`.
