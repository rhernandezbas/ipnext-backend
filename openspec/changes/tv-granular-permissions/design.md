# Design — tv-granular-permissions (#50)

## Key architectural facts (audited)
- DB almacena `(moduleCode, action)` como columnas separadas. NO existe formato colon en ningún lado; el `tv:read` de comentarios es shorthand conceptual.
- El wire contract (punto) lo construye `ResolveUserPermissions.ts:69` → `` `${perm.moduleCode}.${perm.action}` ``. Cualquier acción nueva sobre `tv` sale automáticamente como `tv.{action}` al /me. NO hay transformación extra que tocar.
- Guard: `requirePerm(module, action)` (app.ts:620) → `requirePermission(rbacUserRepo, module, action)`. super_admin corta antes (sentinel).
- `KNOWN_ACTIONS` (rbac.ts:19) es el whitelist global de acciones; `action` es VARCHAR(64), no enum → agregar acciones es solo extender la lista TS + migración data.

## Action codes (decisión)
Se agregan a `KNOWN_ACTIONS`: `'link'`, `'register'`, `'packs'`, `'ott'`, `'cancel'`. Verbos cortos, consistentes con `close`/`reopen`/`void`/`sync`. Wire keys resultantes: `tv.link`, `tv.register`, `tv.packs`, `tv.ott`, `tv.cancel`.

## Route → permission mapping (BE)
| METHOD PATH | ANTES | DESPUÉS |
|---|---|---|
| GET `/config` | tv.manage | tv.manage (sin cambio) |
| PUT `/config` | tv.manage | tv.manage (sin cambio) |
| GET `/summary` | tv.read | tv.read (sin cambio) |
| GET `/accounts` | tv.read | tv.read (sin cambio) |
| GET `/customers/:id/account` | tv.read | tv.read (sin cambio) |
| POST `/customers/:id/link` | tv.write | **tv.link** |
| POST `/customers/:id/register` | tv.write | **tv.register** |
| POST `/customers/:id/services` | tv.write | **tv.packs** |
| DELETE `/customers/:id/services/:serviceId` | tv.write | **tv.packs** |
| PUT `/customers/:id/ott` | tv.write | **tv.ott** |
| POST `/customers/:id/cancel` | tv.write | **tv.cancel** |

`GigaredRouterDeps`: `requireWrite` se reemplaza por `requireLink`, `requireRegister`, `requirePacks`, `requireOtt`, `requireCancel`. `requireRead`/`requireManage` quedan. Wiring en app.ts:1696-1698 → 5 nuevos `requirePerm('tv', ...)`.

## Migration (data-only idempotente)
`prisma/migrations/20260705000000_tv_granular_permissions/migration.sql`. Sin BEGIN/COMMIT.
1. Seed 5 nuevas `RbacPermission` para módulo `tv` (`link`,`register`,`packs`,`ott`,`cancel`), `ON CONFLICT (moduleId, action) DO NOTHING`.
2. Grant las 5 a `administrador` (back-compat: hoy tiene `tv.write` que cubría todo) — `ON CONFLICT (roleId, permissionId) DO NOTHING`.
3. (super_admin NO necesita rows — sentinel `*`. Pero por consistencia con la migración #47 que sí le dio rows, se le otorgan también las 5, idempotente.)
4. NO se borra `tv.write` (idempotencia; queda huérfano sin guard que lo use). Otros roles sin cambios.

## FE mapping (Can por acción)
GigaredPanel.tsx — reemplazar `tv.write` por la clave granular en cada control:
| Control | línea aprox | ANTES | DESPUÉS |
|---|---|---|---|
| Vincular (link CIC) | 575 | tv.write | tv.link |
| Registrar cuenta | 737 | tv.write | tv.register |
| Quitar pack | 1006 | tv.write | tv.packs |
| Agregar pack (sección) | 1039 | tv.write | tv.packs |
| OTT/Suspender/Reactivar/Baja (sección) | 1079 | tv.write | **dividir**: Suspender+Reactivar → tv.ott; Dar de baja + confirmar baja → tv.cancel |
| ContractCard TV chip / picker | — | tv.read | tv.read (sin cambio) |
| Settings tab + body | — | tv.manage | tv.manage (sin cambio) |
| GigaredAccountsPage route / Sidebar | — | tv.read | tv.read (sin cambio) |

Nota crítica FE: el bloque `<Can permission="tv.write">` de línea 1079 hoy envuelve OTT + baja juntos. Hay que PARTIRLO: OTT (suspender/reactivar) bajo `tv.ott`, baja (dar de baja + confirmar + reintentar baja) bajo `tv.cancel`. Items locales (clients.write) NO se tocan.

## Back-compat verificación
- super_admin: sentinel `*` → todo, intacto.
- administrador: tenía tv.write (cubría link/register/packs/ott/cancel) → ahora tiene los 5 granulares → MISMA capacidad. ✓
- Roles sin tv.write hoy: no operaban TV → siguen sin operar. Si tenían tv.read, lo conservan. ✓
- Ningún rol pierde capacidad.

## Tests (targeted, strict TDD red→green)
- BE: `gigared.routes.test.ts` (cada ruta exige su permiso granular; 403 con permiso ajeno), `gigared-composition.test.ts` (wiring requirePerm con nuevas acciones), `gigared-migration.test.ts` (snapshot SQL nuevo), `rbac` domain (acciones en KNOWN_ACTIONS).
- FE: `GigaredPanel.test.tsx` (cada control gateado por su clave), typecheck.
