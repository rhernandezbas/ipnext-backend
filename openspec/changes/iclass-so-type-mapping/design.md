# Design: iclass-so-type-mapping

## Contexto

Hoy IClass recibe TODAS las OS con `typeSOSummary = ICLASS_DEFAULT_SO_TYPE` ("VISITA TECNICA WIRELESS"), rompiendo la clasificación operativa. Esta change introduce un catálogo cacheado de tipos de SO de IClass (`IClassSoType`), liga cada `Project` a un tipo del catálogo, y resuelve `soType` deterministamente en `SendTaskToIClass`. Se elimina el fallback por env var: si el Project no tiene mapeo, el envío falla con error tipado. Arquitectura hexagonal estricta. TDD.

## Architecture Decisions

### AD-1: FK en `Project`, no en `Workflow` ni en `ProjectType`

`Project.iclassSoTypeId` (nullable). Decisión cerrada del usuario.

**Por qué Project y no Workflow**: un mismo Workflow puede aplicarse a Projects distintos (ej. "Workflow Field Service" usado por "Instalaciones FTTH" y "Reparaciones FTTH"). El tipo de SO en IClass discrimina QUÉ trabajo se hace, lo cual coincide con la semántica de Project (un Project = un tipo concreto de trabajo recurrente), no con la del Workflow (que solo dicta las etapas del flujo).

**Por qué Project y no ProjectType**: ProjectType es una taxonomía gruesa interna que ya estaba sub-utilizada. Acoplar IClass a ella forzaría a re-clasificar Projects en función del catálogo externo. Project es el nodo concreto al que el operador ya navega para configurarlo, y el mapeo 1:1 con un tipo IClass calza naturalmente.

**Trade-off aceptado**: si dos Projects deberían enviar el mismo tipo a IClass, hay que setearles el mismo `iclassSoTypeId` (no hay propagación automática vía ProjectType). Se considera aceptable: el catálogo IClass tiene 26 entradas, no se espera explosión.

### AD-2: El caller pasa `soType` por llamada — el adapter no lo resuelve

`CreateServiceOrderInput.soType: string` (requerido). `IClassClient` ya NO recibe `defaultSoType` por constructor. El use case `SendTaskToIClass` carga `project.iclassSoType.code` y lo pasa explícito.

**Por qué**: respeta DIP. El adapter es un transporte HTTP "tonto" — no conoce el modelo de dominio (Project, IClassSoType). Si el adapter resolviera `soType` por sí mismo necesitaría acceder al repositorio de tipos, lo cual lo acopla a la capa de aplicación. Además, hacer `soType` un campo requerido del input convierte la regla "no se manda OS sin tipo" en una invariante de compilación (TypeScript no deja olvidarlo).

**Alternativa descartada**: pasar el `IClassSoTypeRepository` al adapter para que resuelva. Rechazada: viola la dirección de dependencias.

### AD-3: Soft-delete del catálogo (`active: false`) en lugar de borrar

`SyncIClassSoTypeCatalog` marca como `active: false` los códigos que dejan de aparecer en IClass, en vez de borrarlos. Preserva las FKs históricas de Projects que ya tenían ese tipo asignado.

**Trade-off**: `GET /api/admin/iclass/so-types?active=true` filtra para el dropdown del FE, pero `SendTaskToIClass` valida `active === true` al momento del envío y rechaza con `IClassSoTypeInactiveError` si el tipo del Project quedó inactivo. Mensaje claro: hay que re-mapear.

### AD-4: Resolver el Project del task vía `SchedulingRepository.getTaskProjectMapping(taskId)`

Necesitamos cargar `task.project.iclassSoType` dentro de `SendTaskToIClass`. Dos opciones:

- (a) Inyectar `ProjectRepository` al use case y hacer `projects.getById(task.projectId)` + load del tipo.
- (b) Extender `SchedulingRepository` con un método `getTaskProjectMapping(taskId): { projectId, projectTitle, iclassSoType: { id, code, active } | null } | null`.

**Elegimos (b)**. Razones:

1. El JOIN `ScheduledTask → Project → IClassSoType` es una sola operación lógica para este use case. Pedirlo en un solo método al repo de scheduling evita N+1s y mantiene la query optimizable del lado Prisma.
2. El use case `SendTaskToIClass` ya depende de `SchedulingRepository`; agregar un método ahí evita una nueva dependencia.
3. El método devuelve un DTO chato, no entidades Prisma — respeta la convención.

**Costo**: la interfaz del port crece en un método. Aceptable.

### AD-5: Errores separados por causa, no un único `IClassMappingMissingError`

Tres errores de dominio distintos, cada uno con código HTTP propio para que el FE pueda renderizar el mensaje exacto:

- `MissingProjectForIClassError` (task sin `projectId`)
- `MissingIClassMappingError(projectTitle)` (Project sin `iclassSoTypeId`)
- `IClassSoTypeInactiveError(code)` (tipo asignado pero inactivo tras un sync)

**Por qué**: cada caso requiere una acción distinta del operador (asignar Project / mapear Project / re-mapear a un tipo activo). Errores diferenciados habilitan UX accionable. Todos son 422 con `code` distinto.

### AD-6: Sync manual, sin cron, sin mutex

`POST /api/admin/iclass/so-types/sync` es manual. No hay scheduler. No hay mutex/lock — `upsertMany` es idempotente por `code` (unique index), y `deactivateMissing` opera por diferencia de conjuntos. Dos operadores ejecutando sync simultáneo terminan con el mismo estado final.

**Trade-off**: si IClass agrega un código entre las dos sync calls, una de ellas podría desactivarlo y la otra reactivarlo. En la práctica los operadores no corren sync concurrente; rehacerlo es trivial.

### AD-7: Migración aditiva en un solo deploy con la remoción de `ICLASS_DEFAULT_SO_TYPE`

La migración (nueva tabla + columna nullable) y la remoción de `ICLASS_DEFAULT_SO_TYPE` (config, env.example, workflow, IClassClient) van en un mismo commit/push. CI corre la migración antes del deploy del código. Como la columna FK es nullable y el código nuevo ya no lee `defaultSoType`, no hay ventana intermedia rota.

**Riesgo aceptado**: Projects existentes quedan sin mapeo → envíos a IClass fallan con `MissingIClassMappingError` hasta que un admin (1) corra sync, (2) mapee cada Project activo. La feature flag `iclass-integration` sigue OFF en prod por default — se enciende después de mapear.

## Domain Model

### Nueva entidad: `IClassSoType`

```ts
// src/domain/entities/iclass-so-type.ts
export interface IClassSoType {
  id: string;
  code: string;          // trimmed `codigo` from IClass — unique
  description: string;   // trimmed `descricao`
  active: boolean;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

`code` es la clave natural (es lo que IClass acepta como `typeSOSummary` en el payload). `id` (uuid) es la FK desde Project — más estable ante un eventual rename de `code` del lado IClass.

### Relación

`Project.iclassSoTypeId: String?` con FK `onDelete: SetNull`. Soft-delete preserva integridad referencial; cascade no aplica porque marcamos `active: false` en vez de borrar.

## Ports

### `IClassPort` (modified)

```ts
export interface IClassSoTypeDescriptor {
  code: string;
  description: string;
}

export interface CreateServiceOrderInput {
  soCode: string;
  customerCode: string;
  customerName: string;
  phone: string;
  address: string;
  city: string;
  description: string;
  /** typeSOSummary for IClass. Resolved by the caller from project.iclassSoType.code. */
  soType: string;
}

export interface IClassPort {
  listNodes(): Promise<IClassNode[]>;
  /** Catalog of SO types available for the configured thirdParty. */
  listServiceOrderTypes(): Promise<IClassSoTypeDescriptor[]>;
  createServiceOrder(input: CreateServiceOrderInput): Promise<{ orderCode: string }>;
}
```

### `IClassSoTypeRepository` (new)

> Spec REQ-CAT-2 prefers per-entry over bulk for simplicity at this scale (~26 entries).

```ts
// src/domain/ports/IClassSoTypeRepository.ts
export interface UpsertSoTypeInput {
  code: string;
  description: string;
}

export interface SyncSummary {
  created: number;
  updated: number;
  reactivated: number;  // rows that were active=false and came back
  deactivated: number;  // returned by markInactiveExcept, surfaced by the use case
}

export interface IClassSoTypeRepository {
  list(filter?: { active?: boolean }): Promise<IClassSoType[]>;
  getById(id: string): Promise<IClassSoType | null>;
  getByCode(code: string): Promise<IClassSoType | null>;
  /** Upserts a single entry by `code`. Reactivates the row if it was `active=false`. */
  upsertByCode(entry: UpsertSoTypeInput): Promise<{ status: 'created' | 'updated' | 'reactivated' }>;
  /** Marks `active=false` every row whose `code` is NOT in `presentCodes`. Returns count. */
  markInactiveExcept(presentCodes: string[]): Promise<number>;
}
```

### `SchedulingRepository` (extended)

Add:

```ts
interface TaskProjectMapping {
  projectId: string;
  projectTitle: string;
  iclassSoType: { id: string; code: string; active: boolean } | null;
}

getTaskProjectMapping(taskId: string): Promise<TaskProjectMapping | null>;
```

Returns `null` if the task itself doesn't exist or `task.projectId` is null. The use case differentiates between "task not found" and "task has no project" by reading `task.projectId` from the existing `getTask` (already loaded).

## Adapter changes

### `IClassClient`

1. Constructor: REMOVE `defaultSoType` from `IClassClientOptions` and from the class field.
2. `buildServiceOrderPayload`: `typeSOSummary: input.soType` (was `this.defaultSoType`).
3. NEW `listServiceOrderTypes()`:
   ```
   GET /thirdparties/{thirdPartyId}/serviceorders/types?pagesize=200
   → maps objects[] → [{ code: String(o.codigo).trim(), description: String(o.descricao).trim() }]
   → filters out entries with empty code (defensive)
   ```
   Auth flow reuses `authedGet` / `withAuthRetry`. Network failures → `IClassUnavailableError`.

### `InMemoryIClassClient`

Adds a `serviceOrderTypes: IClassSoTypeDescriptor[]` field (settable for tests) and implements `listServiceOrderTypes()` to return it. `createServiceOrder` records `input.soType` in the captured payload for assertion.

### Factory (`iclass.factory.ts`)

```ts
export function buildIClassClient(): IClassPort {
  const { baseUrl, username, password, thirdPartyId } = config.iclass;
  if (username && password && thirdPartyId) {
    return new IClassClient({ baseUrl, username, password, thirdPartyId });
  }
  return new InMemoryIClassClient();
}
```

### New: `PrismaIClassSoTypeRepository`

`upsertMany`:
- Wrap in a transaction (`prisma.$transaction([...])`).
- For each input: `upsert({ where: { code }, create: {...}, update: { description, active: true, lastSyncedAt: now } })`. `create` returns a row, `update` returns a row — Prisma doesn't expose "was create vs update vs reactivate" directly, so we pre-query existing rows by `code`, compute the diff in JS, then issue the writes. This is O(n) with n ≤ 200 (page size) — acceptable.
- `reactivated` = count of rows that pre-existed with `active=false` and are in the incoming set.

`deactivateMissing`:
- `updateMany({ where: { active: true, code: { notIn: presentCodes } }, data: { active: false } })`.
- Returns `result.count`.

### `InMemoryIClassSoTypeRepository`

Backing `Map<string, IClassSoType>` keyed by id, plus a secondary index by code. Implements every port method. Used by use case + route tests.

## Use cases

### `SyncIClassSoTypeCatalog` (new)

```ts
class SyncIClassSoTypeCatalog {
  constructor(
    private readonly iclass: IClassPort,
    private readonly repo: IClassSoTypeRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(): Promise<SyncSummary> {
    const remote = await this.iclass.listServiceOrderTypes(); // throws IClassUnavailableError
    const presentCodes = remote.map(r => r.code);
    const upsertResult = await this.repo.upsertMany(remote, this.now());
    const deactivated = await this.repo.deactivateMissing(presentCodes);
    return { ...upsertResult, deactivated };
  }
}
```

### `ListIClassSoTypes` (new)

```ts
class ListIClassSoTypes {
  constructor(private readonly repo: IClassSoTypeRepository) {}
  execute(filter?: { active?: boolean }): Promise<IClassSoType[]> {
    return this.repo.list(filter);
  }
}
```

### `AssignIClassSoTypeToProject` (new)

```ts
class AssignIClassSoTypeToProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly soTypes: IClassSoTypeRepository,
  ) {}

  async execute(projectId: string, iclassSoTypeId: string | null): Promise<Project> {
    if (iclassSoTypeId !== null) {
      const type = await this.soTypes.getById(iclassSoTypeId);
      if (!type) throw new IClassSoTypeNotFoundError(iclassSoTypeId);
      if (!type.active) throw new IClassSoTypeInactiveError(type.code);
    }
    const updated = await this.projects.updateIClassSoType(projectId, iclassSoTypeId);
    if (!updated) throw new ProjectNotFoundError(projectId);
    return updated;
  }
}
```

Invoked from inside the existing `UpdateProject` use case when `dto.iclassSoTypeId` is present — see HTTP section.

### `SendTaskToIClass` (modified)

New flow (additions in **bold**):

```
execute(taskId, targetStageId, workflowId?)
  ├─ task = tasks.getTask(taskId)        → null? TaskNotFoundError
  ├─ flag OFF                            → plain move, return
  ├─ task.iclassOrderCode != null        → idempotent move to "Registrado", return
  ├─ **task.projectId == null            → throw MissingProjectForIClassError**
  ├─ **mapping = tasks.getTaskProjectMapping(taskId)**
  ├─ **mapping.iclassSoType == null      → throw MissingIClassMappingError(mapping.projectTitle)**
  ├─ **mapping.iclassSoType.active===false → throw IClassSoTypeInactiveError(mapping.iclassSoType.code)**
  ├─ required-fields validation          (unchanged)
  ├─ listNodes + city match              (unchanged)
  ├─ createServiceOrder({ ..., **soType: mapping.iclassSoType.code** })
  └─ setIClassOrderCode + move to "Registrado"
```

Constructor signature unchanged — `SchedulingRepository` already injected gets the new method. Order of checks: project mapping is verified BEFORE field validation because it's cheaper (already-loaded data, no IClass round trip) and more deterministic — if the Project isn't mapped, no other validation matters.

**Idempotency note**: the idempotency guard (`iclassOrderCode != null`) stays FIRST. A previously-sent task with the orderCode set should still advance the stage even if its Project lost its mapping after the fact. This matches the spirit of AD-7 in the prior change (don't re-create OS on retries).

## HTTP layer

### Routes (new file `iclass-admin.routes.ts`)

```
POST /api/admin/iclass/so-types/sync
  auth: requireAdmin
  body: {}
  → 200 { created, updated, reactivated, deactivated }
  → 502 if IClassUnavailableError

GET /api/admin/iclass/so-types?active=true|false
  auth: requireAdmin
  → 200 [{ id, code, description, active, lastSyncedAt }]
```

Mounted at `/api/admin/iclass/so-types` in `app.ts`. Wiring uses `buildIClassClient()` and a new `PrismaIClassSoTypeRepository`.

### Modified: `PATCH /api/projects/:id`

Zod schema gains an optional field:

```ts
iclassSoTypeId: z.string().uuid().nullable().optional()
```

Route handler:
- If `iclassSoTypeId` is present in body (including `null`), call `AssignIClassSoTypeToProject` BEFORE the rest of the update. If it throws, the whole PATCH fails (atomic from the client's view) — no partial update.
- Alternative cleaner: extend `UpdateProject` use case to accept the field and resolve the type inside, dispatching to `AssignIClassSoTypeToProject` internally. Picked alternative: integrate inside `UpdateProject` so the route stays thin.

### Error mapping (`domainErrorToCode.ts`)

| Domain error | HTTP | code |
|--------------|------|------|
| `MissingProjectForIClassError` | 422 | `iclass.missing_project` |
| `MissingIClassMappingError` (carries `projectTitle`) | 422 | `iclass.missing_mapping` |
| `IClassSoTypeInactiveError` (carries `code`) | 422 | `iclass.inactive_so_type` |
| `IClassSoTypeNotFoundError` | 404 | `iclass.so_type_not_found` |

All errors live in `src/domain/errors/iclass.ts` next to the existing ones.

## Migration

Prisma schema additions:

```prisma
model IClassSoType {
  id           String    @id @default(uuid())
  code         String    @unique
  description  String
  active       Boolean   @default(true)
  lastSyncedAt DateTime
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  projects     Project[]

  @@index([active])
}

model Project {
  // ... existing fields ...
  iclassSoTypeId String?
  iclassSoType   IClassSoType? @relation(fields: [iclassSoTypeId], references: [id], onDelete: SetNull)

  @@index([iclassSoTypeId])
}
```

Generate with `npm run prisma:migrate -- --name iclass_so_type_catalog`. Aditiva: nueva tabla + columna nullable + índice. Sin backfill.

## Removal of `ICLASS_DEFAULT_SO_TYPE`

| File | Change |
|------|--------|
| `src/infrastructure/config.ts:65` | Remove `defaultSoType` from `config.iclass`. |
| `env.example:44` | Remove the `ICLASS_DEFAULT_SO_TYPE=` line. |
| `.github/workflows/deploy.yml:53` | Remove `-e ICLASS_DEFAULT_SO_TYPE=...`. |
| `docs/iclass-integration.md` | Update env table + add "SO type mapping per Project" section. |
| `src/infrastructure/adapters/iclass/IClassClient.ts` | Remove `defaultSoType` field + constructor option. |
| `src/infrastructure/http/iclass.factory.ts` | Stop passing `defaultSoType`. |
| `src/__tests__/infrastructure/adapters/IClassClient.test.ts` | Remove `defaultSoType: 'INSTALL'` from constructor args; assert `payload.serviceOrder.typeSOSummary === input.soType`. |

The remove of `ICLASS_DEFAULT_SO_TYPE` is included in the same change because the type check on `IClassClientOptions` would otherwise fail at compile time as soon as the constructor field is removed. All-or-nothing.

## Frontend integration points (enabled, not designed)

This change unblocks:

- **Admin > IClass SO Types page**: "Sync from IClass" button (POST to sync endpoint), catalog table (code, description, active, lastSyncedAt).
- **Project edit form**: "IClass SO Type" dropdown populated from `GET /api/admin/iclass/so-types?active=true`. Allow clear (null).
- **Project list**: column or badge with `iclassSoType.description` or "Sin mapeo".
- **"Send to IClass" modal**: render the three new error codes with actionable messages:
  - `iclass.missing_project` → "La tarea no tiene Project asignado..."
  - `iclass.missing_mapping` (with `projectTitle`) → "El Project «{title}» no tiene mapeo a IClass..."
  - `iclass.inactive_so_type` → "El tipo «{code}» fue desactivado. Re-mapear el Project."

Permisos: `/api/admin/iclass/*` requiere rol admin.

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Projects existentes sin mapeo → todos los envíos fallan tras deploy | High | El flag `iclass-integration` queda OFF en prod hasta que admin (1) corra sync, (2) mapee Projects activos. Procedure documentado en `docs/iclass-integration.md`. |
| Lockstep deploy: config code y env removal deben ir juntos | Med | Una sola PR, una sola migración, un solo deploy. CI corre migración antes del start del code nuevo. |
| Soft-delete deja Project apuntando a tipo inactivo | Med | `SendTaskToIClass` valida `active` y rechaza con `IClassSoTypeInactiveError` claro. FE muestra "re-mapear". |
| Sync concurrente desordenado | Low | Idempotente por `code`. No mutex (AD-6). |
| `lastSyncedAt` actualizado en cada sync inunda updates | Low | `upsertMany` ya escribe esa fila aunque no cambie nada — aceptable, n ≤ 200. |
| IClass devuelve códigos con espacios/mayúsculas inconsistentes | Med | `code` se guarda trimmed; comparación contra Project.iclassSoType es por id, no por code (Project apunta a UUID). |

## Testing strategy

### Unit / use case (in-memory ports)

- `SyncIClassSoTypeCatalog`:
  - Catálogo vacío → todos `created`.
  - Re-sync sin cambios → `updated` igual al total, `created=0`, `deactivated=0`.
  - Un código desaparece → `deactivated=1`, fila queda con `active=false`.
  - Un código previamente desactivado reaparece → `reactivated=1`.
  - IClass falla → propaga `IClassUnavailableError`.

- `ListIClassSoTypes`:
  - Sin filtro → devuelve todos.
  - `{ active: true }` → excluye inactivos.

- `AssignIClassSoTypeToProject`:
  - id válido y activo → asigna.
  - id null → limpia.
  - id inexistente → `IClassSoTypeNotFoundError` (404).
  - id de tipo inactivo → `IClassSoTypeInactiveError` (422).
  - projectId inexistente → `ProjectNotFoundError`.

- `SendTaskToIClass` (extiende los tests existentes):
  - Task sin `projectId` → `MissingProjectForIClassError`.
  - Project sin `iclassSoTypeId` → `MissingIClassMappingError` con `projectTitle`.
  - Project con tipo inactivo → `IClassSoTypeInactiveError` con `code`.
  - Happy path → `createServiceOrder` recibe `soType === project.iclassSoType.code`.
  - Task ya tiene `iclassOrderCode` y Project perdió mapeo → idempotente, mueve a "Registrado" sin error.

### Adapter (mocked axios)

- `IClassClient.listServiceOrderTypes`: stub `GET /thirdparties/{id}/serviceorders/types`, asserts mapeo `codigo→code` (trim), `descricao→description` (trim), filtro de empty codes, re-login on 401.
- `IClassClient.createServiceOrder`: asserts `payload.serviceOrder.typeSOSummary === input.soType` (dinámico, no fijo).

### Route (supertest + repos in-memory)

- `POST /api/admin/iclass/so-types/sync`: 200 con summary; 502 si el port falla; 401 sin admin.
- `GET /api/admin/iclass/so-types?active=true`: filtra inactivos; 401 sin admin.
- `PATCH /api/projects/:id { iclassSoTypeId }`: setea, limpia, 404 si tipo no existe, 422 si inactivo.
- E2E del endpoint de move-to-stage que dispara `SendTaskToIClass` cubriendo los tres errores nuevos.

## Rollback

La FK es nullable y la tabla es aditiva. Para rollback:

1. Revertir el código (vuelve a leer `ICLASS_DEFAULT_SO_TYPE`).
2. Restaurar la env var en el workflow.
3. Las columnas/tabla nuevas pueden quedar en DB (no afectan). O `prisma migrate resolve` para limpiar.

Mientras el catálogo esté vacío o los Projects no estén mapeados, todos los "Enviar a IClass" fallan — esto es deliberado (fail-fast). El flag default OFF protege el rollout.

## Open questions

Ninguna bloqueante. Spec fase definirá el copy exacto de los mensajes de error y los detalles de paginación del endpoint `GET /api/admin/iclass/so-types` (si aplica).
