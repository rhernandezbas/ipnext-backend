# Design: Recaptación — Admin asigna leads (BE)

## Context

El modelo actual (`#80` recaptación) deja que cualquier agente con `recapture.manage` se auto-tome leads (`POST /leads/claim-next`, `POST /leads/:id/claim`) y vea TODOS los leads (`GET /leads` sin restricción). El negocio cambió: ahora el admin asigna, el agente no auto-toma y solo ve lo suyo. Esto exige un permiso granular nuevo y restricción server-side por actor.

Estado verificado del código:
- `prisma/schema.prisma` ~2459 — `RecaptureLead` YA tiene `assigneeId` (FK `RbacUser`, onDelete SetNull), `claimedAt`, `status` enum (`nuevo|en_gestion|contactado|interesado|recuperado|descartado`). **No hay migración de schema.**
- `src/infrastructure/http/routes/recapture.routes.ts` — router con 10 use cases + auth + `{read, manage}` perms (posicional). Montado en `/api/recapture` (app.ts ~2077).
- `src/infrastructure/http/middleware/requirePermission.ts` — `requirePermission(userRepo, module, action)`: resuelve `req.user.id`, short-circuit `super_admin`, luego `userRepo.listPermissionsForUser(userId)`. **`req.user` NO trae permisos cargados** — viven en `RbacUserRepository`.
- `src/domain/entities/rbac.ts` — `KNOWN_ACTIONS` (no contiene `assign`), `RBAC_MODULES` (contiene `recapture`).
- Permisos en DB vía migración (`20260717000100_grant_recapture_permissions`) + paridad dev en `prisma/seed.ts` (~509). Última migración: `20260803000000_ticket_contract`.

## Decisions

### D1 — Permiso nuevo `recapture.assign`: migración de datos + paridad en seed

Los permisos RBAC viven en la DB (`RbacModule` / `RbacPermission` / `RbacRolePermission`). El `seed.ts` es "dev parity" y NO se corre en cada deploy de prod (el deploy aplica migraciones). Por lo tanto el permiso debe entrar por **migración de datos idempotente**, replicando exactamente el patrón de `20260717000100_grant_recapture_permissions` / `20260730000000_pppoe_rbac_permissions`:

- Migración: `prisma/migrations/20260804000000_recapture_assign_permission/migration.sql` (timestamp posterior a `20260803000000`).
- `INSERT RbacPermission (recapture, 'assign') ... ON CONFLICT ("moduleId","action") DO NOTHING`.
- Grants a `super_admin` y `administrador` con `... ON CONFLICT ("roleId","permissionId") DO NOTHING`.
- El módulo `recapture` ya existe (no se re-crea; la migración previa lo creó), pero el INSERT del permiso resuelve `moduleId` por `m.code = 'recapture'` igual que el patrón existente.
- Paridad dev en `seed.ts`: extender el loop `for (const action of ['read','manage'])` a incluir `'assign'` (idempotente, upsert) para que el entorno local también lo tenga.
- Action code: agregar `'assign'` a `KNOWN_ACTIONS` en `src/domain/entities/rbac.ts` (sub-action del módulo recapture), de lo contrario `PermissionAction` no lo tipa y `requirePerm('recapture','assign')` no compila.

**Por qué migración Y seed**: la migración cubre prod/staging (idempotente, parte del historial); el seed cubre `prisma db seed` en local. Ambos idempotentes, sin conflicto.

### D2 — Chequeo de permiso del actor inline: capability `hasAssignPerm` inyectada

La restricción server-side requiere saber, dentro del handler, si el actor tiene `recapture.assign`. `req.user` no trae permisos. Opciones evaluadas:
- (a) Pasar el `RbacUserRepository` entero al router — leakea superficie innecesaria.
- (b) **Inyectar una función `hasAssignPerm: (userId: string) => Promise<boolean>`** (elegida) — closure sobre `RbacUserRepository` armada en `app.ts`. Respeta DIP (el router depende de un tipo función, no de Prisma), es trivial de stubear en tests, y reusa la misma lógica que `requirePermission` (super_admin short-circuit + `listPermissionsForUser`).

La implementación de `hasAssignPerm` en `app.ts`:
```ts
const hasRecaptureAssign = async (userId: string): Promise<boolean> => {
  const roles = await rbacUserRepo.listRolesForUser(userId);
  if (roles.some((r) => r.code === 'super_admin')) return true;
  const perms = await rbacUserRepo.listPermissionsForUser(userId);
  return perms.some((p) => p.moduleCode === 'recapture' && p.action === 'assign');
};
```
El router recibe `hasAssignPerm` como parámetro nuevo y un middleware `assign` nuevo en el objeto `perms`.

### D3 — Restricción server-side por actor

- `GET /leads`: si `!await hasAssignPerm(actorId)` → forzar `query.assigneeId = actorId` y `query.unassigned = false`, ignorando cualquier filtro de query que exponga otros leads. Si tiene assign → comportamiento actual (todos los filtros).
- `GET /leads/:id`, `PATCH /leads/:id` (estado), `POST /leads/:id/contacts`: si `!await hasAssignPerm(actorId)` → tras resolver el lead, validar `lead.assigneeId === actorId`. Si no coincide → responder **404** (`RECAPTURE_LEAD_NOT_FOUND`) para no filtrar la existencia de leads ajenos (defense in depth: el agente no debe poder enumerar). Nota: el prompt admite 403 o 404; se elige 404 para no revelar existencia. Si el lead no existe → 404 igual. Si el actor tiene assign → sin restricción.
  - Para `PATCH /leads/:id` y `POST /leads/:id/contacts`, la verificación de pertenencia se hace recuperando el lead vía `getLead`/repo ANTES de mutar.

### D4 — Bulk assign

Use case nuevo `AssignRecaptureLeadsBulk(repo, userLookup)`:
- `execute(leadIds: string[], operatorId: string | null): Promise<{ assigned: number }>`.
- Si `operatorId !== null`: validar que el usuario existe (vía `EntityLookup`, igual que `AssignRecaptureLead`); si no → `ReferenceNotFoundError('assignee', operatorId)`.
- Itera `leadIds`, llama `repo.assign(leadId, operatorId)` por cada uno; cuenta los que devolvieron lead no-null (los inexistentes se ignoran silenciosamente y NO cuentan). Devuelve `{ assigned: <count> }`.
- Endpoint `PATCH /api/recapture/leads/assign-bulk` body `{ leadIds: string[], operatorId: string|null }`, gateado `[assign]`. Validaciones de body: `leadIds` array no vacío de strings; `operatorId` string o null (presente). 400 `VALIDATION_ERROR` si falla. `ReferenceNotFoundError` → 400 `REFERENCE_NOT_FOUND`. Devuelve `{ assigned }`.
- Reusa `repo.assign` (ya existe); NO agrega método nuevo al port.

### D5 — Eliminación de self-take

- Borrar rutas `POST /leads/claim-next` y `POST /leads/:id/claim` del router.
- Borrar use cases `ClaimNextRecaptureLead` y `ClaimRecaptureLead` + sus referencias (imports, params del router, wiring en `app.ts`, los 4 test files de rutas, el use-case test).
- Retirar `claimNext()` del `RecaptureRepository` port + de los adapters Prisma e in-memory (solo lo usaba `ClaimNextRecaptureLead`).
- **Mantener `claim()` en el port + adapters**: varios tests lo usan como helper de setup para dejar un lead en estado claimed (`repo.claim(id, op)`). Es una primitiva atómica legítima; no se expone vía HTTP. (Alternativa: migrar esos setups a `repo.assign`; se deja a criterio del implementador en TDD, pero la recomendación es conservar `claim()` para minimizar churn.)
- Tras la eliminación, las rutas viejas deben responder **404** (Express no las matchea).

### D6 — `release`: ELIMINAR (decisión reportada)

`POST /leads/:id/release` + `ReleaseRecaptureLead` limpiaban assignee y reseteaban a `nuevo`. Con self-take eliminado, esa operación es **idéntica** a `PATCH /leads/:id/assign { operatorId: null }` (que el admin ya usa para desasignar). Es superficie muerta y redundante → se elimina (ruta + use case + `release()` del port/adapters). El desasignar lo hace el admin con `assign(null)`, gateado `[assign]` — coherente con "solo el admin asigna/desasigna". Se reporta como decisión.

### D7 — Firma del router

El router usa args posicionales. Se quitan `claimLead` y `claimNextLead` y `releaseLead`; se agregan `assignBulk` (use case) y `hasAssignPerm` (capability), y `assign` al objeto `perms`. Hay 5 call sites a actualizar: `app.ts` + 4 test files (`recapture.routes.test.ts`, `recapture-assign.routes.test.ts`, `recapture-csv.routes.test.ts`, `recapture-refine.routes.test.ts`). Se mantiene posicional para no inflar el cambio; todos los sitios se actualizan de forma consistente.

## Risks

- **Romper test files existentes** al cambiar la firma del router: mitigado actualizando los 4 + app.ts en el mismo cambio.
- **404 vs 403 en lead ajeno**: se elige 404 (no filtrar existencia). Si el FE espera 403, ajustar el contrato — documentado en proposal/spec.
- **Migración de permiso no corre**: mitigado con paridad en seed + idempotencia; si el deploy no aplica la migración, el admin no tendría `assign` y los endpoints de admin darían 403 (fail-closed, sin daño de datos).
