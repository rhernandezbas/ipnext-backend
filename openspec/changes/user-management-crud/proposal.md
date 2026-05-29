# Proposal — user-management-crud (SDD #2)

**Status**: draft
**Repos**: `ipnext-backend` (openspec + engram) | `ipnext-frontend` (engram-only)
**Depends on**: SDD #1 (RBAC foundation — deployed 2026-05-29)
**Blocks**: SDD #4 (audit-log-mutations), SDD #6 (legacy admin retirement)

## Intent

SDD #1 dejó la base RBAC en prod (5 entidades + 5 ports + 5 adapters Prisma/InMemory + middleware `requirePerm` SIN montar). El sistema tiene 6 roles seed en DB pero ningún `RbacUser`. La pantalla `AdminPage` sigue consumiendo el `Admin` legado.

Este SDD entrega la **primera superficie productiva de RBAC**: CRUD de usuarios con asignación de roles, montando por primera vez el middleware `requirePerm('admin','manage')`. La intención del usuario fue clara: "crear un usuario con nombre, correo, login, cambio de clave opcional al editar, y selección de permisos modulares — vía rol". Mapeamos "permisos modulares" a **roles** (no overrides per-user) porque la matriz módulo×acción ya vive en el `RbacRole`.

Por qué ahora: sin pantalla de usuarios el RBAC es inerte. Sin el middleware montado, las rutas de SDD #4/#5 no tienen contrato de gating probado en prod.

## Scope

### IN

**Backend** (`ipnext-backend`):
- 10 use cases en `src/application/use-cases/rbac/`:
  - `ListRbacUsers`, `GetRbacUser`, `CreateRbacUser`, `UpdateRbacUser`, `DeleteRbacUser`
  - `ChangeRbacUserPassword`
  - `AssignRoleToUser`, `RemoveRoleFromUser`, `SetRolesForUser` (bulk idempotente), `ListRolesForUser`
- DTOs: `src/application/dto/rbacUser.dto.ts` — `CreateRbacUserDto`, `UpdateRbacUserDto`, `RbacUserDto`, `RbacUserWithRolesDto` (TODOS strip `passwordHash`)
- Rutas montadas en `src/infrastructure/http/routes/rbacUser.routes.ts`:
  - `GET /admin/rbac/users` | `GET /admin/rbac/users/:id` | `POST /admin/rbac/users` | `PATCH /admin/rbac/users/:id` | `DELETE /admin/rbac/users/:id`
  - `POST /admin/rbac/users/:id/password` (cambio explícito)
  - `GET /admin/rbac/users/:id/roles` | `PUT /admin/rbac/users/:id/roles` (replace bulk) | `POST /admin/rbac/users/:id/roles` (assign single) | `DELETE /admin/rbac/users/:id/roles/:roleId`
- TODAS protegidas por `requirePerm('admin','manage')` — **primer mount productivo del middleware**
- Hashing: `bcryptjs` (mismo cost factor que `auth.routes.ts`)
- Tests: use-case tests con InMemory + supertest route tests con repos in-memory inyectados

**Frontend** (`ipnext-frontend`):
- API: `src/api/rbacUsers.api.ts`, `src/api/rbacRoles.api.ts` (read-only para el selector)
- Types: `src/types/rbacUser.ts`, `src/types/rbacRole.ts`
- Hooks: `src/hooks/useRbacUsers.ts` (list/get/create/update/delete/setRoles), `src/hooks/useRbacRoles.ts` (list)
- Body extraído: `src/pages/system/admin/RbacUsersBody.tsx` con sub-componente `RbacUserModal` (create+edit, password opcional en edit, multi-select de roles)
- Patch a `src/pages/system/AdminPage.tsx`: tab `'admins'` (id se mantiene, label → "Usuarios") renderiza `<RbacUsersBody/>` en lugar del contenido legacy
- Diseño del modal + body vía **skill `impeccable`**: jerarquía visual, validación inline, multi-select accesible, sticky header, empty state
- Tests: vitest con `vi.mock` hooks + `renderBody` helper (patrón `SchedulingTaskCategoriesPage` adaptado a body)

### OUT (diferido — se mencionan para que el spec los liste explícitamente)

| # | Item | Va en |
|---|------|-------|
| 1 | Per-user permission overrides (más allá de rol) | Future SDD |
| 2 | Activity / audit log de mutaciones | SDD #4 |
| 3 | Listado de sesiones por usuario | SDD #5 |
| 4 | Password policy (longitud, complejidad) | SDD #6 |
| 5 | 2FA | SDD #6 |
| 6 | Migración `Admin` legacy → `RbacUser` y retiro de `/admin/admins` | SDD #6 |

### Coexistencia

El tab `'admins'` cambia de contenido, no de id. `admin.routes.ts`, `role.routes.ts`, `auth.routes.ts`, `useAdmins.ts`, `admin.api.ts` quedan intactos pero sin consumidor en UI. Borrado en SDD #6.

## Approach

### Backend

- **Use cases puros**: cada uno recibe los ports vía constructor (`RbacUserRepository`, `RbacRoleRepository`, `RbacUserRoleRepository`, `PasswordHasher`). El hashing se inyecta como port nuevo `PasswordHasher` (`hash(plain)`, `compare(plain, hash)`) — adapter `BcryptPasswordHasher` en `infrastructure/adapters/bcrypt/`. Esto desacopla `bcryptjs` del use case y permite tests sin coste de hashing real (in-memory hasher que prefija `hashed::`).
- **DTO discipline**: el mapper `toRbacUserDto(entity)` vive junto al DTO y SIEMPRE omite `passwordHash`. Type-level guard: `RbacUserDto` no incluye el campo, así un `as RbacUserDto` no compila si lo dejamos. Tests verifican que el JSON serializado no contenga la clave.
- **Routes**: archivo nuevo `rbacUser.routes.ts` factory `createRbacUserRouter(deps)`. Montado en `app.ts` BAJO `/admin/rbac/users` con `requirePerm('admin','manage')` aplicado a nivel router (`router.use(requirePerm(...))`).
- **SetRolesForUser**: implementación idempotente — calcula diff vs estado actual y solo aplica delta. Transacción opcional (el InMemory no la necesita; en Prisma usamos `$transaction`).
- **Validación**: login único (constraint DB + check explícito en use case con error `LOGIN_ALREADY_TAKEN`), email format básico, password mínimo 8 chars (regla MÍNIMA acá — la policy completa es SDD #6).

### Frontend

- **File layout**: `src/pages/system/admin/RbacUsersBody.tsx` (body component, NO default export — exportado nombrado para tree-shake). Sigue el patrón sub-bodies de `iclass-back-office` (engram #289).
- **Hook contract**: `useRbacUsers()` → list con TanStack Query, key `['rbac','users']`. Mutaciones invalidan esa key y `['rbac','users',id]`. `useSetUserRoles(userId)` mutación independiente que invalida `['rbac','users',userId]`.
- **Role selector UX** (a refinar con `impeccable`): multi-select con chips, agrupado visualmente entre "Roles del sistema" (los 6 seed) y "Roles personalizados" (custom). Cada chip muestra código + label humano. Click en chip toggles. Validación: al menos 1 rol requerido al crear (o aceptar usuario sin rol? — open question).
- **Password field**: en create es required + visible. En edit es **collapsed por default** detrás de un toggle "Cambiar contraseña" — vacío = no cambia. Confirmación de password en el mismo modal.
- **Modal**: sticky header (convención FE), footer con primary/secondary, validación inline con `react-hook-form`. Empty state del body con CTA "Crear primer usuario".

## Per-repo split

| Layer | Backend (`ipnext-backend`) | Frontend (`ipnext-frontend`) |
|-------|----------------------------|------------------------------|
| Domain / Ports | New port `PasswordHasher` en `src/domain/ports/PasswordHasher.ts` | — |
| Application | 10 use cases en `src/application/use-cases/rbac/`, DTO file `rbacUser.dto.ts` | — |
| Infrastructure | Adapter `BcryptPasswordHasher`, route `rbacUser.routes.ts`, wiring en `app.ts` (mount + DI) | — |
| API client | — | `src/api/rbacUsers.api.ts`, `src/api/rbacRoles.api.ts` |
| State | — | `src/hooks/useRbacUsers.ts`, `src/hooks/useRbacRoles.ts` |
| UI | — | `src/pages/system/admin/RbacUsersBody.tsx` (+ `RbacUserModal` interno), patch a `AdminPage.tsx` |
| Types | — | `src/types/rbacUser.ts`, `src/types/rbacRole.ts` |
| Tests | use-case (InMemory) + route (supertest) | vitest + Testing Library con hooks mockeados |
| Commit boundary | 1 commit BE | 1 commit FE |

## Risks

1. **Primer mount de `requirePerm` en prod**. Si el middleware lanza 500 (bug) o 403 erróneo (config), nadie puede gestionar usuarios.
   - *Mitigación*: test de integración explícito que ejerza el middleware con usuario sin permiso (espera 403) y con permiso (200). Feature flag NO se usa (el tab nuevo es la única superficie). Bypass de emergencia: el `super_admin` legacy `Admin` sigue pudiendo accederse vía DB para crear el primer `RbacUser` (ver siguiente riesgo).

2. **Bootstrap del primer `RbacUser`**. No hay ninguno en prod. El form requiere `admin:manage`. Chicken-and-egg.
   - *Mitigación propuesta*: agregar a `prisma/seed.ts` (o script one-off `scripts/bootstrap-rbac-superadmin.ts`) la creación de UN `RbacUser` con rol `super_admin` a partir de envs `BOOTSTRAP_RBAC_LOGIN` / `BOOTSTRAP_RBAC_EMAIL` / `BOOTSTRAP_RBAC_PASSWORD`. Idempotente: si ya existe un user con rol `super_admin`, no-op. Se ejecuta en deploy y se documenta en CHANGELOG. **Decisión a confirmar en spec.**

3. **Labels humanas de los 6 roles**. El BE devuelve `code` (`super_admin`, `administrador`, ...). El FE necesita "Super Admin", "Administrador", etc.
   - *Opciones*: (a) hardcodear un dict en `src/constants/rbacRoleLabels.ts` en FE — simple pero divergente del BE; (b) agregar `displayName` al `RbacRole` y devolverlo desde la API — más limpio, requiere migration y backfill; (c) i18n via `t('rbac.roles.super_admin')` — overkill hoy.
   - *Propuesta*: **(a) hardcode FE** ahora, **(b)** cuando agreguemos roles custom user-defined (SDD #3 ya los soporta vía `RbacRole.name`). El BE devolvería `name` si existe, code de fallback.

4. **Hash leakage**. Si un use case nuevo olvida mapear DTO y devuelve la entity, `passwordHash` se filtra al cliente.
   - *Mitigación*: type-level — `RbacUserDto` NO tiene `passwordHash`. Lint/test runtime: snapshot test del response JSON verificando ausencia de la key `passwordHash`. Code review checklist en el design doc.

5. **`SetRolesForUser` ↔ concurrencia**. Dos admins editando los roles del mismo usuario al mismo tiempo → last-write-wins.
   - *Aceptable* en SDD #2 (uso esperado bajo). Spec lo documenta como limitación conocida.

## Open questions (decisiones requeridas antes del spec)

1. **Tab id**: ¿se mantiene `'admins'` o pasa a `'usuarios'`? Mantener evita romper deep-links existentes (si los hay). **Propuesta: mantener `'admins'`, cambiar solo label**.
2. **Bootstrap superadmin**: ¿seed script vía env vars (propuesta) o endpoint one-shot `/admin/rbac/bootstrap` protegido por shared secret? Propuesta: **seed/script — más simple, sin superficie HTTP nueva**.
3. **¿Permitir crear usuario SIN rol asignado?** Si sí, queda inerte hasta que se le asigne uno (no puede hacer nada). Si no, el create form requiere al menos 1 rol. **Propuesta: requerir ≥1 rol al crear**, permitir quedar en 0 al editar (con warning UI).
4. **Self-edit / self-delete**: ¿el usuario logueado puede editarse / borrarse a sí mismo? Riesgo: borrarse el único super_admin → lockout. **Propuesta: prohibir self-delete y prohibir quitarse el rol `super_admin` a uno mismo si quedaría 0 super_admins**.
5. **Password mínimo**: ¿8 chars suficiente para SDD #2 (full policy en #6) o algo más estricto ya? **Propuesta: 8 chars no-vacío, sin más reglas** — la policy completa va en SDD #6.

---

**Next**: `sdd-spec` + `sdd-design` en paralelo una vez resueltas las 5 open questions (o asumiendo las propuestas si el usuario aprueba en bloque).
