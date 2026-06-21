<!-- generated from engram topic_key: sdd/customer-zones-map/design -->
## Context
Feature de **zonas visuales** sobre Leaflet. Arquitectura hexagonal estricta (`domain ← application ← infrastructure`). Strict TDD (Jest + adapters in-memory). Cross-repo BE+FE, permisos granulares en **ambas** capas.

## Decisión 1 — Geometría como `Json`, NO PostGIS
Las zonas son SOLO visuales (decisión del usuario). No hay queries espaciales (point-in-polygon, intersección, área). Por lo tanto:
- `Zone.points` = `Json` (jsonb en Postgres) = array ordenado de `{ lat, lng }`.
- **NO** se agrega PostGIS (extensión pesada, requiere superuser en prod, innecesaria para render).
- Futuro: si se necesita point-in-polygon → evaluar PostGIS o cálculo en app; hoy sería over-engineering.

**Tradeoff:** sin validación geométrica a nivel DB; la validación vive en el use case (Decisión 2).

## Decisión 2 — Validación en el use case (dominio), no en la DB
- Polígono válido = **≥ 3 vértices** (mínimo para un polígono).
- Cada punto: `lat ∈ [-90, 90]`, `lng ∈ [-180, 180]`.
- `name` no vacío; `color` hex (`#RGB` / `#RRGGBB`).
- Inválido → `InvalidPolygonError` → **422**. Mapeo en el errorHandler.

## Decisión 3 — RBAC: reusar `read`/`manage`, módulo nuevo `zones`
- **NO** inventar acciones nuevas (`draw`, etc.) — `read` (ver) + `manage` (crear/editar/borrar) alcanzan y siguen el patrón existente.
- Migración **idempotente** (`ON CONFLICT (...) DO NOTHING`): inserta RbacModule `zones`, las 2 RbacPermission, y los grants (administrador: read+manage; super_admin ya pasa por `*`). Resto de roles → desde la PermissionMatrix UI.
- Guard en **CADA** ruta (no alcanza "solo autenticado" — regla innegociable): GET → `zones.read`, writes → `zones.manage`. Ambas capas (BE guard + FE `Can`/`RequirePermission`).

## Decisión 4 — Placement FE: editar SOBRE el mapa de clientes (no página nueva)
- El usuario pidió "editar el mapa de clientes" → la capa de zonas + edición vive en `CustomerMapPage`.
- Toggle "Editar zonas" visible solo con `zones.manage`; activa leaflet-draw. Sin el permiso → solo ve las zonas (si tiene `zones.read`).
- Alternativa **descartada**: página dedicada `/admin/zones`. Se puede sumar después; el modelo/API NO cambia. (**Confirmado por el usuario 2026-06-21: editar sobre el mapa de clientes.**)

## Decisión 5 — Contrato BE↔FE explícito (regla del workflow, seam #28)
`ZoneDto = { id: string, name: string, color: string, points: {lat,lng}[], description: string|null, createdAt: ISO string, updatedAt: ISO string }`. El FE consume EXACTAMENTE esta shape. Documentado campo por campo en AMBOS repos. Test que recorre el viaje completo (use case real + repo in-memory en BE; hook real en FE).

## Layout hexagonal (archivos)
```
domain/entities/zone.ts                         # Zone, ZonePoint
domain/errors/ZoneNotFoundError.ts              # 404
domain/errors/InvalidPolygonError.ts            # 422
domain/ports/ZoneRepository.ts                  # create/findById/list/update/delete
application/use-cases/{CreateZone,ListZones,GetZone,UpdateZone,DeleteZone}.ts
application/dto/zone.dto.ts                      # ZoneDto + mapper (sin Prisma)
infrastructure/adapters/in-memory/InMemoryZoneRepository.ts
infrastructure/adapters/prisma/PrismaZoneRepository.ts   # singleton prisma, NO constructor(prisma)
infrastructure/http/routes/zones.routes.ts      # 5 rutas + guards
infrastructure/http/app.ts                      # wiring + composition test
prisma/migrations/20260805000000_zone_model/migration.sql
prisma/migrations/20260805001000_zones_rbac_permissions/migration.sql
```

## Riesgos
- `Json` column sin esquema fuerte → confiar en validación del use case + tests.
- **Tailwind vs CSS Modules** en el stub FE (ver proposal) — resolver ANTES de codear FE.
- Migración RBAC: respetar el patrón `ON CONFLICT (columna) DO NOTHING`, idempotente; timestamps posteriores a `20260804000000`.
- `(prisma as any).zone` en local hasta `prisma generate` (el Dockerfile lo corre en build → prod OK).
