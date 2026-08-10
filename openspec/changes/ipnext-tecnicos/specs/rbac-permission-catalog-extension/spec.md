# Delta for rbac-permission-catalog-extension (Wave 1b)

Extiende el catálogo RBAC (`RbacModule`/`RbacPermission`, ya migrado a `action VARCHAR(64)` abierto — ver spec base) con el módulo `tech` y sus dos permisos, siguiendo el MISMO patrón de migración aditiva idempotente (`ON CONFLICT DO NOTHING`) que el resto del catálogo. Es aditivo puro: no toca módulos ni permisos existentes.

## ADDED Requirements

### Requirement: A `tech` module gates the technician app surface

El sistema DEBE (MUST) agregar un `RbacModule` con `code='tech'` y sus permisos asociados, con el mismo mecanismo de migración idempotente que el resto del catálogo (`ON CONFLICT (code) DO NOTHING` en módulos, `ON CONFLICT ("moduleId", action) DO NOTHING` en permisos).

Permisos del módulo `tech`:
| action | Semántica |
|---|---|
| `app_access` | Gate de login en `tech-api-auth` — sin este permiso, `POST /api/tech/auth/login` rechaza aunque login/password sean correctos |
| `task_close` | Gate de `POST /api/tech/tasks/:id/close` (`tech-tasks-worklist`) — sin este permiso, el técnico puede ver/transicionar tareas pero no cerrarlas |

#### Scenario: Module and permissions exist after migration
- GIVEN la migración corrió
- WHEN se consulta `RbacModule` por `code='tech'`
- THEN existe, y `RbacPermission` tiene filas para `(tech, app_access)` y `(tech, task_close)`

#### Scenario: Re-running the migration is a no-op
- GIVEN la migración ya se aplicó
- WHEN se corre de nuevo
- THEN no hay error, no hay filas duplicadas (mismo contrato de idempotencia que el resto del catálogo)

### Requirement: The gate is enforced in two independent layers

El sistema DEBE (MUST) exigir DOS capas independientes para operar `/api/tech/*` (decisión cerrada del proposal, "doble capa"): (1) el JWT `aud='tech'` (identidad de superficie, `tech-api-auth`), y (2) el permiso RBAC `tech.app_access` sobre el `RbacUser` (autorización de negocio, re-chequeada en cada request). Ninguna capa reemplaza a la otra.

#### Scenario: A valid tech JWT without the permission is still rejected
- GIVEN un `accessToken` con `aud='tech'` válido y sin expirar
- AND un admin le retira el rol con `tech.app_access` al `RbacUser` dueño del token
- WHEN se usa ese token contra `GET /api/tech/tasks`
- THEN `401` (la capa 2 falla aunque la capa 1 — el JWT — siga siendo válido)

### Requirement: Closing a task from the app requires `tech.task_close` in addition to task ownership

El sistema DEBE (MUST) rechazar `POST /api/tech/tasks/:id/close` con `403 { code: 'PERMISSION_DENIED', module: 'tech', action: 'task_close' }` si el `RbacUser` del token no tiene el permiso, aunque la tarea sí esté asignada a él.

#### Scenario: A technician without task_close cannot close, but can still see and travel-transition
- GIVEN `tech-A` tiene `tech.app_access` pero NO `tech.task_close`
- WHEN hace `GET /api/tech/tasks` o `POST /api/tech/tasks/t-1/travel/start`
- THEN ambas operan normalmente
- AND `POST /api/tech/tasks/t-1/close` responde `403 PERMISSION_DENIED`

## Aditivo, solo-crece
Un módulo y dos permisos nuevos, mismo mecanismo idempotente que el resto del catálogo (spec base, `Step 2-4`). No se modifica ningún módulo/permiso/grant existente. `super_admin` recibe los grants nuevos automáticamente por el `Step 5` ya existente (grant-all).
