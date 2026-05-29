# Proposal: Roles & Permissions Management (Matrix UI + Effective Permissions)

## Intent

Cerrar la promesa "permisos modulares dinámicos" de SDD #1/#2: hoy los 5 roles non-super_admin están vacíos y el FE sigue gateando con `user.role === 'admin'` legacy (roto desde el rewrite JWT — botón delete-task no funciona). Necesitamos: (a) endpoint que devuelva permisos efectivos del usuario, (b) primitivas FE (`<Can>`, hook, guard de página), (c) UI matricial para que un administrador edite permisos por rol, (d) catálogo ampliado de módulos + sub-acciones críticas.

## Scope

### In Scope
- BE: use case `ResolveUserPermissions` (union de permisos por rol del usuario, super_admin → sentinel `["*"]`).
- BE: extender `GET /api/auth/me` con `{ user, roles[], permissions[] }` (additive, no rompe shape actual).
- BE: migration aditiva — 11 módulos nuevos (`voices, partners, rbac, profile, notifications, dashboard, portal, search, support, sla, tariffs`) + base perms + grants super_admin.
- BE: sub-acciones críticas (~22 codes — ver "Locked sub-actions" en design). Action storage migra de enum `RbacAction` a `VARCHAR(64)` con CHECK constraint laxo + validación en use case.
- FE: hook `useMyPermissions()` (TanStack), componente `<Can permission="...">`, wrapper `<RequirePermission>`, página "403 — No tenés permisos".
- FE: filtro de Sidebar por permisos efectivos, mapping `nav → permission` co-locado con rutas.
- FE: reemplazo de los 2 `isAdmin = role === 'admin'` en SchedulingTaskDetailPage:63 y TasksTableView:305.
- FE: UI matricial (módulo × acción × rol) en "Administración → Roles y Permisos" con `impeccable` design, save per-role con optimistic update.

### Out of Scope
- Audit log de cambios de permisos → SDD #4.
- Inheritance / role hierarchies, time-bound perms, per-resource ACLs, rate-limit por rol.
- Self-service password / 2FA flows (sólo se exponen sus permission codes).

## Capabilities

### New Capabilities
- `rbac-effective-permissions`: resolución de permisos efectivos del usuario y endpoint `/api/auth/me` extendido.
- `rbac-permission-matrix`: catálogo extendido (módulos + sub-acciones) + use cases para listar/asignar permisos a un rol.
- `rbac-frontend-primitives`: `<Can>`, `useMyPermissions`, `<RequirePermission>`, nav filter (frontend repo).
- `rbac-permission-matrix-ui`: pantalla matricial editable (frontend repo).

### Modified Capabilities
- `rbac-data-model`: agrega 11 módulos, cambia `RbacPermission.action` de enum a `VARCHAR(64)`.
- `rbac-seed`: seed idempotente para los 11 módulos nuevos + sub-acciones.
- `rbac-user-routes`: `/auth/me` ahora retorna `permissions[]`.

## Approach

Phase 1 desbloquea delete-task (BE `/me` extension + FE `<Can>` + 2 replacements). Phase 2 migra DDL + catálogo. Phase 3 introduce guard de página + nav filter. Phase 4 monta matrix UI. Phase 5 propaga `<Can>` al resto de botones críticos. super_admin bypass del middleware (SDD #1) se mantiene; en `/me` se serializa como `["*"]` para evitar payload gigante.

`RbacAction` enum → `VARCHAR(64)`: ALTER TABLE drop enum, recolumn a varchar, regrant. Migration aditiva idempotente (`ON CONFLICT DO NOTHING`). Decisión locked: no usamos `ALTER TYPE ADD VALUE` porque obliga a actualizar el enum cada vez que aparece una sub-action — varchar + lista whitelisted en código es más flexible.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | `RbacPermission.action` enum → String |
| `prisma/migrations/2026XXXX_rbac_permission_matrix/` | New | DDL + seed aditivo |
| `src/application/use-cases/rbac/ResolveUserPermissions.ts` | New | Union de permisos |
| `src/application/use-cases/rbac/ListRolePermissions.ts` | New | Para el UI |
| `src/application/use-cases/rbac/SetRolePermissions.ts` | New | Atomic replace |
| `src/infrastructure/http/routes/auth.routes.ts` | Modified | `/me` extendido |
| `src/infrastructure/http/routes/role.routes.ts` | Modified | `GET/PUT /:id/permissions` |
| `src/domain/ports/RbacRolePermissionRepository.ts` | Modified | Add `replaceForRole` |
| FE `src/lib/auth/useMyPermissions.ts` | New | TanStack hook |
| FE `src/lib/auth/Can.tsx` | New | Componente conditional |
| FE `src/lib/auth/RequirePermission.tsx` | New | Page guard |
| FE `src/pages/admin/RbacRolesPage/MatrixView.tsx` | New | Matrix UI |
| FE `src/pages/scheduling/...` (2 archivos) | Modified | Reemplazo isAdmin |
| FE `src/components/Sidebar.tsx` | Modified | Filter by perms |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Migration enum→varchar rompe data | Med | Migration en transacción, validar counts pre/post en staging |
| Flash de unauthorized antes de cargar perms | High | `<RequirePermission>` muestra loading state; `useMyPermissions` cached en query client; fetch en bootstrap |
| Payload `/me` grande para super_admin | Low | Sentinel `["*"]` evita serializar 100+ codes |
| Matrix UI confusa con 24 módulos × N acciones | Med | Agrupar por módulo colapsable, search, `impeccable` design review |
| 2 broken role checks quedan rotos hasta Phase 1 | High | Phase 1 se ejecuta antes que todo lo demás (fast path) |

## Rollback Plan

- BE: revertir migration con `prisma migrate resolve --rolled-back` + drop columnas nuevas (DDL inverso en `down.sql`). Endpoint `/me` retorna shape anterior si feature-flag `RBAC_EFFECTIVE_PERMS=false`.
- FE: `<Can>` por defecto en modo `permissive` (renderiza children) si el hook falla → no rompe UI existente.
- Revertir commits Phase 1 desbloquea volver al estado pre-SDD#3 sin tocar DB.

## Dependencies

- SDD #1 (auth-rbac-foundation): tablas + middleware + super_admin bypass.
- SDD #2 (user-management-crud): `/auth/me` actual + JWT shape `{id, login, email}`.

## Success Criteria

- [ ] Botón "Eliminar tarea" funciona para usuarios con `scheduling.delete` (super_admin + cualquier rol custom configurado).
- [ ] Un usuario sin `scheduling.read` no ve "Scheduling" en sidebar y al ir a `/admin/scheduling` ve página "No tenés permisos".
- [ ] Administrador puede crear un rol custom "Técnico Senior", asignar `scheduling.read + write + delete + manage_checklist`, y al loguear el técnico ve sólo eso.
- [ ] `GET /api/auth/me` para super_admin retorna `permissions: ["*"]`; para otro rol retorna lista flat de codes.
- [ ] Migration se ejecuta idempotente en CI (correr dos veces no rompe).
- [ ] 0 ocurrencias de `user?.role === 'admin'` en grep del FE post-Phase-5.

## Open Questions (proposed defaults)

1. **Action storage**: enum vs varchar? → **Default: VARCHAR(64) con whitelist en código.** Locked por mí; spec puede revisar.
2. **`/me` vs `/me/permissions` separado?** → **Default: extender `/me`** (un sólo round-trip en bootstrap). El client puede invalidar por separado vía query key.
3. **super_admin payload**: lista completa vs sentinel `["*"]`? → **Default: sentinel `["*"]`.** FE: `useCan(p)` retorna true si `permissions.includes("*") || permissions.includes(p)`.
4. **`<Can>` fail-mode si hook está cargando**: render nada vs render children? → **Default: render nothing + opcional prop `fallback={<Skeleton/>}`.** Evita flash de botones que después desaparecen.
5. **Module catalog count**: 10 vs 11 nuevos? → **Default: 11** (sumamos `support` por mensajería que ya existe en sidebar). Total = 25 módulos.

Si el usuario acepta los 5 defaults en bloque, el SDD avanza directo a spec+design.
