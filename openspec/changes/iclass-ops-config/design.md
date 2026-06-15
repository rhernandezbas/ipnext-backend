# Design — IClass Ops Config

> Change: `iclass-ops-config`. Diseño técnico de las 3 olas (A: mapeo+auto-asignar, B: toggles, C: visibilidad).
> Hexagonal estricto: use-cases → ports, adapters Prisma/in-memory, DTOs whitelist, STRICT TDD.

## Contexto verificado del código existente

| Pieza | Hallazgo | Implicancia |
|-------|----------|-------------|
| `dispatchTaskToIClass.ts` | Arma `createServiceOrder({ soCode=sequenceNumber, customerCode, customerName, phone, address, city, description, soType, nodeCode })`. NO manda estado inicial. `customerCode` = `contractCode ?? customerCode`. RED/FIBRA usan `NETWORK_PHONE='0000000000'`, `NETWORK_CUSTOMER_CODE='NETWORK'`. | Ola C: el "estado inicial" lo pone IClass (verificado). soType viene de `project.iclassSoType.code`. nodeCode se resuelve por `customerCity` en runtime (`iclass.listNodes()` + match normalizado), NO está fijado por proyecto. |
| `AssignIClassTeam.ts` | Pre-check: flag `iclass-assign-action` → task → `iclassOrderCode` → `generalStatus==='open'` → team `active && selectable` → `getServiceOrder` (no terminal `statusCode!=='7'`) → `updateServiceOrder({ serviceOrderCode, requiredTeam })` → recorder `iclass_team_assigned`. Lanza errores tipados. | Ola A: el auto-asignar REUSA este flujo. Se extrae el "core" a un use case compartido `AutoAssignIClassTeamOnTaskUpdate` que NO lanza (best-effort) y mapea cada error a un outcome registrable. |
| `UpdateTask.ts` | Valida FKs presentes en el body parcial. `assigneeId` se valida contra `adminLookup` (RbacUser). Patrón #40/#66: guards disparan en CAMBIO real, no en presencia (el form FE reenvía el body completo). Snapshot `prev` para el diff de actividades. | Ola A: el guard del auto-asignar dispara cuando `data.assigneeId` ≠ `prev.assigneeId`. Reusa el `prev` ya cargado para el recorder. |
| `IClassPort` | Ya tiene `getServiceOrder`, `updateServiceOrder`, `listTeams`. `IClassClient` sobre `withAuthRetry`. | Ola A: NO se agregan métodos al port. El auto-asignar usa los existentes. |
| `IClassTeam` (entity/port) | `getByLogin`, `list({active, selectable})`, `markInactiveExcept`. `selectable=false` = grouper no-asignable. | Ola A: la sub-page lista cuadrillas `active && selectable`. El mapeo guarda `login` (soft FK). |
| `RbacUser` (entity/port/schema) | `RbacUser { id, name, email, login, status, ... }`. Repo: `list()`, `findById`, `update(id, patch)`. Schema: `model RbacUser`. | Ola A: se agrega `iclassTeamLogin String?` al schema, entity, `UpdateRbacUserInput` (o port dedicado). |
| `FeatureFlag` + `SetFeatureFlag` | `PATCH /api/admin/feature-flags/:key` gate `admin.flags`; `GET /:key`; hook FE `useFeatureFlag`/`useSetFeatureFlag`. | Ola B: FE-only. BE ya completo. |
| FE | `IClassSettingsBody` = array `SUB_TABS` (`{ id, label, content }`) con `<Tabs mountMode="lazy">`. Patrón tabla editable = `IClassStatusCatalogBody` (auto-save por fila, feedback ⏳✓⚠). `useRbacUsers()` → `GET /api/admin/rbac/users`. `useIClassTeams()` → `GET /api/admin/iclass/teams`. | A/B/C: 3 sub-tabs nuevas clonando patrones existentes. |
| Migraciones | Idempotentes, sin BEGIN/COMMIT, `INSERT ... ON CONFLICT DO NOTHING`, `IF NOT EXISTS`. Última = `20260726000000`. | Usar timestamp `20260727000000+`. |
| Permisos | `requirePerm(module, action)` named export en `app.ts`. Gates `iclass.read`/`iclass.manage` ya existen. | No se crean permisos. |

## Decisiones de arquitectura

### AD-1 — Modelo del mapeo Técnico↔Cuadrilla: campo en `RbacUser`, NO tabla

**Decisión:** `RbacUser.iclassTeamLogin String?` (nullable). 1 técnico → 0..1 cuadrilla.

**Por qué campo y no tabla N:N:**
- **Cardinalidad de negocio = 1:1.** Un técnico pertenece a UNA cuadrilla operativa. No hay caso de uso para "técnico en varias cuadrillas". Una tabla `TechnicianTeamMapping(userId, teamLogin)` sería una pivot con `@@unique([userId])` — o sea, una columna disfrazada de tabla. YAGNI: sobre-ingeniería sin requerimiento.
- **Lectura barata.** El auto-asignar necesita `user.iclassTeamLogin` en el hot-path de `UpdateTask`. Un campo se trae con el `RbacUser` que YA se carga; una tabla obliga a un JOIN/lookup extra por cada cambio de assignee.
- **Consistencia con el codebase.** El mapeo proyecto→soType es un campo (`Project.iclassSoTypeId`), no una tabla. Mismo patrón.

**Soft FK por `login`, NO `id`:** se guarda el `IClassTeam.login` (clave estable de negocio), no el `id` (uuid interno). Razón: el catálogo de teams se re-sincroniza con `markInactiveExcept` y los `id` son uuids locales; `login` es la identidad que IClass garantiza. NO se pone FK física a `IClassTeam(login)` — sería un FK a una tabla-catálogo sincronizada (si el sync borrara una fila rompería el FK). Es un **soft FK**: se valida en escritura (la cuadrilla debe existir y ser `selectable` al mapear) y degrada en lectura.

**Degradación (cuadrilla inactiva):**
- En **escritura** (mapear): `SetTechnicianTeamMapping` valida que la cuadrilla exista y sea `active && selectable`. Mapear a inactiva → `IClassTeamNotAssignableError` (422). Desmapear (`null`) siempre permitido.
- En **lectura** (sub-page): `ListTechnicianTeamMappings` hace JOIN lógico con el catálogo y devuelve `{ userId, userName, login, teamName, teamActive }`. `teamActive=false` → el FE lo marca en rojo "cuadrilla inactiva, re-mapeá".
- En **auto-asignar**: si la cuadrilla mapeada quedó inactiva (sync posterior), el auto-asignar la saltea (`skipped: team-inactive`), NO empuja a IClass, registra el skip. La asignación local del técnico procede normal.

### AD-2 — Auto-asignar: colaborador opcional best-effort en `UpdateTask`

**Decisión:** extraer el core de `AssignIClassTeam` a un use case `AutoAssignIClassTeamOnTaskUpdate` (depende de los mismos ports) que **NO lanza** y devuelve un `AutoAssignResult` (`{ outcome: 'assigned' | 'skipped' | 'failed', reason? }`). `UpdateTask` recibe un puerto opcional `IClassAutoAssigner` (interface con un método `maybeAssign(taskId, assigneeId, actor)`); cuando está presente y `assigneeId` cambió, lo invoca DESPUÉS de persistir el update, en un `try/catch` que **nunca** propaga.

**Por qué un colaborador y no inline en `UpdateTask`:**
- **DIP + SRP.** `UpdateTask` no debe conocer `IClassPort`/`IClassTeamRepository`/`FeatureFlagRepository`. Depende de un port nuevo `IClassAutoAssigner` (en `domain/ports/`). El wiring inyecta el use case concreto.
- **Testeable aislado.** El auto-asignar se testea con su propio in-memory; `UpdateTask` se testea con un fake `IClassAutoAssigner` (spy) que verifica "se llamó / no se llamó" sin tocar IClass.
- **Reuso real.** El core (pre-check + push) ya existe en `AssignIClassTeam`. Se factoriza la parte común; `AssignIClassTeam` (acción manual, que SÍ lanza) y `AutoAssignIClassTeamOnTaskUpdate` (best-effort, que NO lanza) comparten el camino feliz pero difieren en el manejo de error.

**Puerto nuevo (`domain/ports/IClassAutoAssigner.ts`):**
```ts
export interface AutoAssignOutcome {
  outcome: 'assigned' | 'skipped' | 'failed';
  reason?: 'flag-off' | 'no-order-code' | 'no-mapping' | 'team-inactive'
         | 'order-closed' | 'rejected' | 'unavailable' | 'not-open';
  teamLogin?: string;
}
export interface IClassAutoAssigner {
  maybeAssign(taskId: string, assigneeId: string | null, actor?: ActorContext): Promise<AutoAssignOutcome>;
}
```

**Flujo de `AutoAssignIClassTeamOnTaskUpdate.maybeAssign`:**
1. `assigneeId == null` → `skipped: no-mapping` (desasignar técnico no toca IClass).
2. flag `iclass-assign-action` OFF → `skipped: flag-off`.
3. `getTask(taskId)`; sin `iclassOrderCode` → `skipped: no-order-code`.
4. `generalStatus !== 'open'` → `skipped: not-open`.
5. `rbacUserRepo.findById(assigneeId)`; sin `iclassTeamLogin` → `skipped: no-mapping`.
6. `teamRepo.getByLogin(login)`; no existe / `!active` / `!selectable` → `skipped: team-inactive`.
7. `getServiceOrder` pre-check; null → `skipped: order-closed` (sin OS); `statusCode==='7'` → `skipped: order-closed`.
8. `updateServiceOrder({ serviceOrderCode, requiredTeam: login })`:
   - OK → recorder `iclass_team_auto_assigned` → `assigned`.
   - `IClassRejectedError` → recorder `iclass_team_auto_assign_failed` (reason en metadata) → `failed: rejected`.
   - `IClassUnavailableError` → idem → `failed: unavailable`.
9. Cualquier error inesperado dentro de `maybeAssign` se captura y se devuelve `failed` (NUNCA propaga). `UpdateTask` además lo envuelve en su propio try/catch como segunda red.

**Guard de cambio en `UpdateTask`:** invocar `maybeAssign` solo si `data.assigneeId !== undefined && updated.assigneeId !== prev.assigneeId`. Reusa el `prev` snapshot (ya se carga cuando hay recorder; si no hay recorder, se carga el prev solo para este guard cuando el auto-assigner está presente y `assigneeId` viene en el body).

### AD-3 — Ola C: preview de despacho es READ-ONLY agregando datos existentes

**Decisión:** `GetIClassDispatchPreview` lee `projects` (con `iclassSoType`) y devuelve, por proyecto mapeado, el resumen de lo que `dispatchTaskToIClass` armaría para una tarea de CLIENTE. NO simula una tarea concreta; describe las REGLAS por proyecto.

Shape por proyecto:
```ts
interface DispatchPreviewRow {
  projectId: string;
  projectTitle: string;
  soType: { code: string; description: string } | null; // del mapeo
  nodeResolution: 'by-customer-city';   // constante: el nodo se resuelve por ciudad
  customerCodeSource: 'contractCode-or-customerCode';
  phoneSource: 'customer-phone';
  soCodeSource: 'task-sequence-number';
  initialStatus: 'assigned-by-iclass';  // verificado: Prominense no manda estado
  hardcoded: { networkPhone: '0000000000'; networkCustomerCode: 'NETWORK' }; // solo informativo (RED/FIBRA)
}
```
El "estado devuelto" (Fase 1) NO se duplica acá: el FE enlaza la sub-tab existente "Estados de IClass". El endpoint es puramente derivado — sin escritura, sin estado nuevo.

### AD-4 — RbacUser: extender el port existente vs. port nuevo

**Decisión:** agregar `iclassTeamLogin?: string | null` a `RbacUser` (entity) y a `UpdateRbacUserInput`, y exponer dos métodos de lectura en `RbacUserRepository`: `listWithIClassTeam(): Promise<RbacUserWithTeam[]>` (para la sub-page; trae el join con `IClassTeam.active`) y reusar `update(id, { iclassTeamLogin })` para el set. El `findById` ya existente debe devolver `iclassTeamLogin` para que el auto-asignar lo lea sin query extra.

**Por qué no un port separado `TechnicianTeamMappingRepository`:** el dato vive en `RbacUser`; un port aparte obligaría a un segundo adapter sobre la misma tabla. El mapeo es un atributo del técnico, no una entidad propia (corolario de AD-1).

## Matriz scenario → test (STRICT TDD — in-memory)

| # | Scenario | Test (archivo) | Adapter |
|---|----------|----------------|---------|
| A1 | Set mapping: técnico → cuadrilla válida (active+selectable) persiste `iclassTeamLogin` | `SetTechnicianTeamMapping.test.ts` | InMemoryRbacUser + InMemoryIClassTeam |
| A2 | Set mapping a cuadrilla inactiva → `IClassTeamNotAssignableError` | `SetTechnicianTeamMapping.test.ts` | idem |
| A3 | Set mapping a cuadrilla no-selectable (grouper) → `IClassTeamNotAssignableError` | `SetTechnicianTeamMapping.test.ts` | idem |
| A4 | Set mapping a `null` (desmapear) siempre OK | `SetTechnicianTeamMapping.test.ts` | idem |
| A5 | Set mapping con userId inexistente → `ReferenceNotFoundError`/404 | `SetTechnicianTeamMapping.test.ts` | idem |
| A6 | List mappings: devuelve técnicos con `{login, teamName, teamActive}`; inactiva → `teamActive=false` | `ListTechnicianTeamMappings.test.ts` | idem |
| B1 | maybeAssign: flag ON + orderCode + open + mapping active + OS no-terminal → `updateServiceOrder` + outcome `assigned` + actividad `iclass_team_auto_assigned` | `AutoAssignIClassTeamOnTaskUpdate.test.ts` | InMemory IClass/Team/Flag/Scheduling/RbacUser |
| B2 | maybeAssign: flag OFF → `skipped: flag-off`, NO toca IClass | idem | idem |
| B3 | maybeAssign: tarea sin `iclassOrderCode` → `skipped: no-order-code` | idem | idem |
| B4 | maybeAssign: técnico sin `iclassTeamLogin` → `skipped: no-mapping` | idem | idem |
| B5 | maybeAssign: assigneeId null → `skipped: no-mapping` | idem | idem |
| B6 | maybeAssign: cuadrilla mapeada quedó inactiva → `skipped: team-inactive`, NO toca IClass | idem | idem |
| B7 | maybeAssign: tarea no `open` → `skipped: not-open` | idem | idem |
| B8 | maybeAssign: OS terminal en IClass (statusCode '7') → `skipped: order-closed`, NO updateServiceOrder | idem | idem |
| B9 | maybeAssign: `updateServiceOrder` lanza `IClassRejectedError` → `failed: rejected` + actividad `iclass_team_auto_assign_failed`, NO propaga | idem | idem (IClass que rechaza) |
| B10 | maybeAssign: IClass caído (`IClassUnavailableError`) → `failed: unavailable`, NO propaga | idem | idem |
| C1 | UpdateTask con `assigneeId` CAMBIADO + auto-assigner presente → invoca `maybeAssign(taskId, newAssignee)` una vez | `UpdateTask.autoassign.test.ts` | InMemoryScheduling + fake assigner (spy) |
| C2 | UpdateTask con `assigneeId` IGUAL al actual → NO invoca `maybeAssign` (no-op) | idem | idem |
| C3 | UpdateTask sin `assigneeId` en el body → NO invoca `maybeAssign` | idem | idem |
| C4 | UpdateTask: `maybeAssign` lanza (red de seguridad) → UpdateTask igual persiste y NO falla | idem | fake assigner que lanza |
| C5 | UpdateTask sin auto-assigner inyectado (undefined) → comportamiento idéntico al actual | idem | sin assigner |
| D1 | DispatchPreview: proyecto con soType mapeado → fila con soType + sources + `initialStatus='assigned-by-iclass'` | `GetIClassDispatchPreview.test.ts` | InMemory projects |
| D2 | DispatchPreview: proyecto sin soType → fila con `soType: null` (visible que está sin mapear) | idem | idem |
| E1 | Prisma adapter: `iclassTeamLogin` round-trip (set/read/null) | `PrismaRbacUserRepository.test.ts` (extender) | Prisma (gated) |
| E2 | Composition-root: app.ts wirea el auto-assigner en UpdateTask sin romper el arranque | `app.composition.test.ts` (extender) | — |
| F1..F6 | Routes (supertest): PATCH/GET technician-teams (200/400/404/403), GET dispatch-preview (200/403) | `iclassTechnicianTeams.routes.test.ts`, `iclassDispatchPreview.routes.test.ts` | in-memory inyectados |

## Wire contract BE↔FE (aditivo)

### Ola A — Mapeo técnico↔cuadrilla
```
GET /api/admin/iclass/technician-teams            (gate iclass.read)
  → 200 { items: [{ userId, userName, userLogin, iclassTeamLogin: string|null,
                    teamName: string|null, teamActive: boolean }] }

PATCH /api/admin/iclass/technician-teams/:userId  (gate iclass.manage)
  body: { iclassTeamLogin: string | null }
  → 200 { userId, iclassTeamLogin, teamName, teamActive }
  → 422 ICLASS_TEAM_NOT_ASSIGNABLE  (cuadrilla inexistente/inactiva/no-selectable)
  → 404 (userId inexistente)
```
FE: nueva sub-tab "Técnicos → Cuadrillas". Tabla = `useRbacUsers()` (filtrada a técnicos) × `useIClassTeams()` (active+selectable para el select) + `useTechnicianTeamMappings()`. Auto-save por fila (patrón `IClassStatusCatalogBody`). Fila con `teamActive=false` → badge rojo.

### Ola B — Toggles (sin BE nuevo)
```
GET   /api/admin/feature-flags/:key   (existente)
PATCH /api/admin/feature-flags/:key   (existente, gate admin.flags)  body { enabled }
```
FE: sub-tab "Acciones de OS" con 2 `IClassFlagBody` clones para `iclass-close-action` y `iclass-assign-action`.

### Ola C — Visibilidad del despacho
```
GET /api/admin/iclass/dispatch-preview   (gate iclass.read)
  → 200 { items: DispatchPreviewRow[] }   (read-only, derivado de projects+mapping)
```
FE: sub-tab "Qué se envía a IClass" (read-mostly) + link a "Mapeo de proyectos", "Estados de IClass" y catálogo de nodos.

## Migración

`prisma/migrations/20260727000000_rbac_user_iclass_team_login/migration.sql` (aditiva, idempotente, sin BEGIN/COMMIT):
```sql
ALTER TABLE "RbacUser" ADD COLUMN IF NOT EXISTS "iclassTeamLogin" TEXT;
CREATE INDEX IF NOT EXISTS "RbacUser_iclassTeamLogin_idx" ON "RbacUser"("iclassTeamLogin");
```
NO se crea FK física a `IClassTeam` (soft FK por login, AD-1). El índice ayuda al "¿qué técnicos tienen esta cuadrilla?" si hiciera falta, y es barato. NO toca datos existentes (columna nullable). Las olas B y C no requieren migración.

## Riesgos y mitigaciones (resumen, detalle en proposal)

- **Auto-asignar dispara escrituras a IClass al cambiar assignee** → best-effort + triple cerrojo + solo-en-cambio + `withAuthRetry` + degradación por cuadrilla inactiva. Nunca aborta el update local.
- **Reasignación masiva = N escrituras** → secuencial, best-effort, sin fan-out paralelo. Documentado.
- **Soft FK puede apuntar a cuadrilla borrada del catálogo** → lectura degrada (`teamActive=false`), auto-asignar saltea. El índice no es FK.
- **`UpdateTask` God-collaborator creep** → el auto-assigner es UN port opcional; `UpdateTask` no gana conocimiento de IClass. Composition-root test verifica el wiring.
