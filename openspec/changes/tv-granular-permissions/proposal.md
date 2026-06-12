# tv-granular-permissions (#50)

## Why
El #47 montó el módulo RBAC `tv` con solo 3 acciones (`read`/`write`/`manage`). Hoy TODA la operación de TV (vincular CIC, registrar cuenta, packs, OTT, suspender/reactivar, dar de baja) cuelga de un único `tv.write` genérico. El usuario pide permisos granulares por acción de negocio para poder dar, por ejemplo, capacidad de ver + agregar packs sin habilitar la baja total.

## What
Granularidad por ACCIÓN DE NEGOCIO (no por endpoint). Nuevas acciones sobre el módulo `tv`:

| Permiso (wire `tv.*`) | Acción de negocio | Reemplaza |
|---|---|---|
| `tv.read` | ver page TV, panel cliente, summary | (existe, conservar) |
| `tv.link` | vincular/desvincular CIC (asociar internal_id) — "creación" de la relación | parte de `tv.write` |
| `tv.register` | registrar/activar cuentas nuevas en el CUA | parte de `tv.write` |
| `tv.packs` | agregar/quitar packs (servicios) | parte de `tv.write` |
| `tv.ott` | habilitar/deshabilitar OTT (incl. suspender/reactivar #47k) | parte de `tv.write` |
| `tv.cancel` | dar de baja TV completa (#47k) | parte de `tv.write` |
| `tv.manage` | config (API key, flag, probar conexión) | (existe, conservar) |

`tv.write` se RETIRA de los guards de ruta (queda en catálogo por idempotencia, sin uso). Los grants existentes de `tv.write` a `administrador` se MAPEAN a las 5 nuevas acciones para que NINGÚN rol pierda capacidad (back-compat).

## Impact
- BE: `KNOWN_ACTIONS` (+5), guards de `gigared.routes.ts` (write→granular), wiring en `app.ts`, migración data-only `20260705000000_tv_granular_permissions`. Wire contract automático (ResolveUserPermissions ya hace `${module}.${action}` con punto).
- FE: `Can` por acción en `GigaredPanel` (cada botón al permiso correspondiente), settings/page sin cambios funcionales (siguen en `tv.manage`/`tv.read`).
- Back-compat: super_admin = `*` (implícito). administrador recibe las 5 nuevas. Otros roles: sin cambios (solo read si lo tenían).
