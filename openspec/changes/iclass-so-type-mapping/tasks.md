# Tasks — iclass-so-type-mapping

Lockstep deploy: migración + código nuevo + remoción de `ICLASS_DEFAULT_SO_TYPE` van en un único push.
Flag `iclass-integration` permanece OFF en prod durante el rollout; se activa DESPUÉS de que un admin (1) ejecute el sync, (2) mapee todos los Projects activos.
STRICT TDD: test rojo primero, implementación, test verde. `npm test` y `tsc --noEmit` deben quedar verdes en cada gate de fase.

---

## FASE 1 — Schema + Domain

### 1.1 — Prisma schema

- [x] 1.1 Agregar modelo `IClassSoType` en `prisma/schema.prisma` con campos `id String @id @default(uuid())`, `code String @unique`, `description String`, `active Boolean @default(true)`, `thirdPartyId String`, `lastSyncedAt DateTime`, `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`, relación `projects Project[]`, e índice `@@index([active])` (REQ-CAT-1, design § Migration).
- [x] 1.2 Agregar `iclassSoTypeId String?` y relación `iclassSoType IClassSoType? @relation(fields: [iclassSoTypeId], references: [id], onDelete: SetNull)` al modelo `Project` + `@@index([iclassSoTypeId])` (AD-1, REQ-PROJ-1).
- [x] 1.3 Generar el archivo de migración ejecutando `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` (o equivalente) y crear el archivo SQL en `prisma/migrations/<timestamp>_iclass_so_type_catalog/migration.sql`. La migración es ADITIVA: nueva tabla + columna nullable + índices. Sin backfill (AD-7).

### 1.2 — Entidad de dominio

- [x] 1.4 Crear `src/domain/entities/iclass-so-type.ts` con la interfaz `IClassSoType` (campos: `id`, `code`, `description`, `active`, `thirdPartyId`, `lastSyncedAt`, `createdAt`, `updatedAt`) conforme a REQ-CAT-1.
- [x] 1.5 Extender la entidad `Project` en `src/domain/entities/scheduling.ts` (o donde viva) para incluir `iclassSoTypeId: string | null` e `iclassSoType: { id: string; code: string; description: string; active: boolean } | null` (REQ-PROJ-1).

### 1.3 — Errores de dominio

- [x] 1.6 Agregar a `src/domain/errors/iclass.ts` los errores:
  - `MissingProjectForIClassError(taskId: string)` — código `MISSING_PROJECT_FOR_ICLASS` (REQ-SCHED-ERR-1).
  - `MissingIClassMappingError(projectTitle: string)` — código `MISSING_ICLASS_MAPPING`, expone `projectTitle` (REQ-SCHED-ERR-2).
  - `IClassSoTypeInactiveError(code: string)` — código `ICLASS_SO_TYPE_INACTIVE`, expone `iclassSoTypeId` para el handler (AD-5).
  - `IClassSoTypeNotFoundError(id: string)` — código `ICLASS_SO_TYPE_NOT_FOUND` (REQ-PROJ-4).
- [x] 1.7 Registrar los cuatro errores nuevos en `src/infrastructure/http/middleware/errorHandler.ts` (`statusMap`): `MISSING_PROJECT_FOR_ICLASS: 422`, `MISSING_ICLASS_MAPPING: 422`, `ICLASS_SO_TYPE_INACTIVE: 422`, `ICLASS_SO_TYPE_NOT_FOUND: 404` (design § HTTP layer → Error mapping).
- [x] 1.8 Extender `src/application/util/domainErrorToCode.ts` para propagar `projectTitle` desde `MissingIClassMappingError` y `iclassSoTypeId` desde `IClassSoTypeInactiveError` en la respuesta HTTP (AD-5).

### Gate Fase 1

`tsc --noEmit` verde. `npm test` verde (ningún test roto por el schema nuevo).

**Commit:**
```
feat(iclass): add IClassSoType domain model, errors and migration scaffold
```
**Files to `git add`:**
```
prisma/schema.prisma
prisma/migrations/<timestamp>_iclass_so_type_catalog/migration.sql
src/domain/entities/iclass-so-type.ts
src/domain/entities/scheduling.ts
src/domain/errors/iclass.ts
src/application/util/domainErrorToCode.ts
src/infrastructure/http/middleware/errorHandler.ts
```

---

## FASE 2 — Ports + In-Memory adapters (TDD)

### 2.1 — Puerto `IClassSoTypeRepository`

- [x] 2.1 Crear `src/domain/ports/IClassSoTypeRepository.ts` con la interfaz y sus tipos auxiliares (`UpsertIClassSoTypeInput`, etc.) siguiendo el contrato del design (REQ-CAT-2):
  - `upsertByCode(entry: UpsertIClassSoTypeInput): Promise<IClassSoType>`
  - `markInactiveExcept(codes: string[], thirdPartyId: string): Promise<void>`
  - `list(filter?: { active?: boolean; thirdPartyId?: string }): Promise<IClassSoType[]>`
  - `getById(id: string): Promise<IClassSoType | null>`
  - `getByCode(code: string): Promise<IClassSoType | null>`

### 2.2 — Puerto `IClassPort` (modificar)

- [x] 2.2 Agregar `soType: string` (requerido, sin default) al interface `CreateServiceOrderInput` en `src/domain/ports/IClassPort.ts` (REQ-PORT-2).
- [x] 2.3 Agregar método `listServiceOrderTypes(thirdPartyId: string): Promise<IClassSoTypeDescriptor[]>` al interface `IClassPort`. Definir `IClassSoTypeDescriptor { code: string; description: string }` en el mismo archivo (REQ-PORT-3).

### 2.3 — Puerto `SchedulingRepository` (extender)

- [x] 2.4 Agregar método `getTaskProjectMapping(taskId: string): Promise<TaskProjectMapping | null>` al interface `SchedulingRepository` en `src/domain/ports/SchedulingRepository.ts`. Definir `TaskProjectMapping { projectId: string; projectTitle: string; iclassSoType: { id: string; code: string; active: boolean } | null }` (AD-4, REQ-SCHED-6).

### 2.4 — In-memory adapters (TDD)

- [x] 2.5 **(TEST ROJO)** `src/__tests__/infrastructure/InMemoryIClassSoTypeRepository.test.ts`: `upsertByCode` crea y actualiza; `markInactiveExcept` deja activos solo los presentes; `list({ active: true })` filtra; `getById`/`getByCode` devuelven null si no existen; reactivación de `active: false` cuando el código reaparece (REQ-SYNC-1 escenarios).
- [x] 2.6 Implementar `src/infrastructure/adapters/in-memory/InMemoryIClassSoTypeRepository.ts` — Map keyed by id + índice secundario por code (REQ-CAT-2).
- [x] 2.7 **(TEST VERDE)** 2.5 pasa.
- [x] 2.8 Extender `src/infrastructure/adapters/in-memory/InMemoryIClassClient.ts`:
  - Agregar campo `serviceOrderTypes: IClassSoTypeDescriptor[] = []` (configurable para tests).
  - Implementar `listServiceOrderTypes(thirdPartyId: string)` que devuelve `this.serviceOrderTypes`.
  - Modificar `createServiceOrder` para registrar `input.soType` en `createdOrders` (para assertions) (design § InMemoryIClassClient).
- [x] 2.9 Extender `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` con la implementación de `getTaskProjectMapping(taskId)`: buscar la tarea, si existe y tiene `projectId`, devolver `{ projectId, projectTitle, iclassSoType }` del project en memoria; si no existe o `projectId` es null, devolver `null` (AD-4).

### Gate Fase 2

`tsc --noEmit` verde. `npm test` verde.

**Commit:**
```
feat(iclass): add IClassSoTypeRepository port, extend IClassPort + SchedulingRepository, in-memory adapters
```
**Files to `git add`:**
```
src/domain/ports/IClassSoTypeRepository.ts
src/domain/ports/IClassPort.ts
src/domain/ports/SchedulingRepository.ts
src/infrastructure/adapters/in-memory/InMemoryIClassSoTypeRepository.ts
src/infrastructure/adapters/in-memory/InMemoryIClassClient.ts
src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts
src/__tests__/infrastructure/InMemoryIClassSoTypeRepository.test.ts
```

---

## FASE 3 — Use cases (TDD)

### 3.1 — `SyncIClassSoTypes`

- [ ] 3.1 **(TEST ROJO)** `src/__tests__/application/SyncIClassSoTypes.test.ts` — cubrir todos los escenarios de REQ-SYNC-1:
  - Catálogo vacío + 3 tipos → 3 entries activas, `{ synced: 3, deactivated: 0 }`.
  - Re-sync idempotente → `{ synced: 3, deactivated: 0 }`, `syncedAt` actualizado.
  - Un código desaparece → entry con `active: false`, `{ synced: 2, deactivated: 1 }`.
  - Código previamente desactivado reaparece → `active: true`.
  - IClass falla → propaga `IClassUnavailableError`.
  - `thirdPartyId` viene del config inyectado, no hardcodeado (REQ-SYNC-2).
- [ ] 3.2 Implementar `src/application/use-cases/SyncIClassSoTypes.ts`: inyecta `IClassPort`, `IClassSoTypeRepository` y `thirdPartyId: string`; llama `listServiceOrderTypes(thirdPartyId)` → `upsertByCode` por cada entry → `markInactiveExcept` → retorna `{ synced, deactivated }` (REQ-SYNC-1).
- [ ] 3.3 **(TEST VERDE)** 3.1 pasa.

### 3.2 — `ListIClassSoTypes`

- [ ] 3.4 **(TEST ROJO)** `src/__tests__/application/ListIClassSoTypes.test.ts`: sin filtro → todos; `{ active: true }` → solo activos (REQ-LIST-CAT-1).
- [ ] 3.5 Implementar `src/application/use-cases/ListIClassSoTypes.ts` (REQ-LIST-CAT-1).
- [ ] 3.6 **(TEST VERDE)** 3.4 pasa.

### 3.3 — `AssignIClassSoTypeToProject`

- [ ] 3.7 **(TEST ROJO)** `src/__tests__/application/AssignIClassSoTypeToProject.test.ts`:
  - id válido y `active: true` → asigna y devuelve Project actualizado (REQ-PROJ-6).
  - id `null` → limpia el mapeo (REQ-PROJ-5).
  - id inexistente → `IClassSoTypeNotFoundError` (REQ-PROJ-4).
  - id de tipo `active: false` → `IClassSoTypeInactiveError` (REQ-PROJ-3).
  - `projectId` inexistente → `ProjectNotFoundError`.
- [ ] 3.8 Implementar `src/application/use-cases/AssignIClassSoTypeToProject.ts`: inyecta `ProjectRepository` + `IClassSoTypeRepository`; valida tipo si no es null; llama `projects.updateIClassSoType(projectId, iclassSoTypeId)` (AD-3 guard en asignación).
- [ ] 3.9 Agregar método `updateIClassSoType(projectId: string, iclassSoTypeId: string | null): Promise<Project | null>` al port `ProjectRepository` (si no existe); extender `InMemoryProjectRepository` y `PrismaProjectRepository` con este método.
- [ ] 3.10 **(TEST VERDE)** 3.7 pasa.

### 3.4 — `SendTaskToIClass` (modificar)

- [ ] 3.11 **(TEST ROJO)** Extender `src/__tests__/application/SendTaskToIClass.test.ts` con los nuevos escenarios (spec scheduling):
  - Task con `projectId: null` → `MissingProjectForIClassError`, sin llamada a IClass (REQ-SCHED-1).
  - Task con Project pero `iclassSoTypeId: null` → `MissingIClassMappingError` con `projectTitle` (REQ-SCHED-2).
  - Task con Project con tipo `active: false` → `MissingIClassMappingError` (no `IClassSoTypeInactiveError`) (REQ-SCHED-3).
  - Happy path con `iclassSoType.active: true` → `createServiceOrder` recibe `soType === project.iclassSoType.code` (REQ-SCHED-4).
  - Task ya tiene `iclassOrderCode` y Project perdió mapeo → idempotente, mueve a "Registrado en IClass" sin error (design § SendTaskToIClass, nota idempotency).
  - Flag OFF → mueve sin validar project/soType (REQ-SCHED-5).
  - Ajustar fixtures existentes: en los tests ya existentes que pasan, asegurarse de que el task tenga `projectId` y el project tenga `iclassSoType.active: true` con un `code`, o que el flag sea OFF.
- [ ] 3.12 Modificar `src/application/use-cases/SendTaskToIClass.ts` — insertar la resolución del mapping DESPUÉS del guard de idempotencia y ANTES de la validación de campos requeridos:
  1. Si `task.projectId == null` → throw `MissingProjectForIClassError(task.id)`.
  2. Llamar `tasks.getTaskProjectMapping(taskId)` (nuevo método del repo).
  3. Si `mapping.iclassSoType == null || !mapping.iclassSoType.active` → throw `MissingIClassMappingError(mapping.projectTitle)`.
  4. Pasar `soType: mapping.iclassSoType.code` a `iclass.createServiceOrder` (AD-2, REQ-SCHED-4).
- [ ] 3.13 **(TEST VERDE)** 3.11 pasa. `npm test` verde completo.

### Gate Fase 3

`npm test` verde. `tsc --noEmit` verde.

**Commit:**
```
feat(iclass): add SyncIClassSoTypes, ListIClassSoTypes, AssignIClassSoTypeToProject use cases; soType resolution in SendTaskToIClass
```
**Files to `git add`:**
```
src/application/use-cases/SyncIClassSoTypes.ts
src/application/use-cases/ListIClassSoTypes.ts
src/application/use-cases/AssignIClassSoTypeToProject.ts
src/application/use-cases/SendTaskToIClass.ts
src/domain/ports/ProjectRepository.ts
src/infrastructure/adapters/in-memory/InMemoryProjectRepository.ts
src/__tests__/application/SyncIClassSoTypes.test.ts
src/__tests__/application/ListIClassSoTypes.test.ts
src/__tests__/application/AssignIClassSoTypeToProject.test.ts
src/__tests__/application/SendTaskToIClass.test.ts
```

---

## FASE 4 — Adapters Prisma + HTTP routes (TDD)

### 4.1 — `IClassClient` real (modificar)

- [ ] 4.1 **(TEST ROJO)** Extender `src/__tests__/infrastructure/IClassClient.test.ts`:
  - `listServiceOrderTypes`: stub `GET /thirdparties/{id}/serviceorders/types`, verifica que `codigo` y `descricao` se trimean, que se mapean a `code`/`description`, y que re-login on 401 funciona (REQ-PORT-3).
  - `createServiceOrder`: assert que `payload.serviceOrder.typeSOSummary === input.soType` (dinámico, no el viejo `defaultSoType`) (REQ-PORT-2, design § IClassClient).
- [ ] 4.2 Modificar `src/infrastructure/adapters/iclass/IClassClient.ts`:
  - Implementar `listServiceOrderTypes(thirdPartyId: string)`: `authedGet` a `/thirdparties/${thirdPartyId}/serviceorders/types?pagesize=200`, mapea `objects[]` a `{ code: trim(o.codigo), description: trim(o.descricao) }` (REQ-PORT-3, design § IClassClient).
  - Cambiar `buildServiceOrderPayload` para usar `input.soType` en `typeSOSummary` en lugar de `this.defaultSoType` (REQ-PORT-2).
- [ ] 4.3 **(TEST VERDE)** 4.1 pasa.

### 4.2 — `PrismaIClassSoTypeRepository`

- [ ] 4.4 **(TEST ROJO)** `src/__tests__/infrastructure/PrismaIClassSoTypeRepository.test.ts` — con Prisma mockeado o en modo integración; verificar: upsert crea si no existe, actualiza si existe, reactiva si estaba inactivo; `markInactiveExcept` hace un solo `updateMany` (AD-6); `list({ active: true })` filtra; `getByCode` retorna null si no existe.
- [ ] 4.5 Implementar `src/infrastructure/adapters/prisma/PrismaIClassSoTypeRepository.ts` implementando el port `IClassSoTypeRepository`:
  - `upsertByCode`: pre-query por `code`, calcula diff, escribe con `upsert`; reactiva si existía con `active=false` (design § PrismaIClassSoTypeRepository).
  - `markInactiveExcept`: `prisma.iClassSoType.updateMany({ where: { active: true, code: { notIn: codes }, thirdPartyId }, data: { active: false } })` (AD-6).
  - `list`, `getById`, `getByCode`: queries simples con include/where.
- [ ] 4.6 **(TEST VERDE)** 4.4 pasa.

### 4.3 — `PrismaSchedulingRepository.getTaskProjectMapping`

- [ ] 4.7 **(TEST ROJO)** Extender `src/__tests__/infrastructure/PrismaSchedulingRepository.test.ts` (o el equivalente): `getTaskProjectMapping` devuelve el mapping con iclassSoType; devuelve null si task no tiene project; ejecuta UNA sola query (AD-4, single JOIN).
- [ ] 4.8 Implementar `getTaskProjectMapping(taskId)` en `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts`: query `findUnique` con `include: { project: { include: { iclassSoType: true } } }`, devuelve DTO chato `{ projectId, projectTitle, iclassSoType }` o null (AD-4).
- [ ] 4.9 **(TEST VERDE)** 4.7 pasa.

### 4.4 — `PrismaProjectRepository.updateIClassSoType`

- [ ] 4.10 Implementar `updateIClassSoType(projectId, iclassSoTypeId)` en `src/infrastructure/adapters/prisma/PrismaProjectRepository.ts`: `update` con `include: { iclassSoType: true }` para devolver el Project con el tipo inline; retornar `null` si el project no existe (REQ-PROJ-1).

### 4.5 — HTTP routes (TDD)

- [ ] 4.11 **(TEST ROJO)** `src/__tests__/infrastructure/iclass-admin.routes.test.ts` con supertest + in-memory repos:
  - `POST /api/admin/iclass/so-types/sync`: 200 con `{ synced, deactivated }`; 502 si `IClassUnavailableError`; 401 sin admin auth (REQ-HTTP-SYNC-1, REQ-HTTP-SYNC-2).
  - `GET /api/admin/iclass/so-types?active=true`: 200 solo activos; `GET /api/admin/iclass/so-types` devuelve todos; 401 sin auth (REQ-HTTP-LIST-1, REQ-HTTP-LIST-2).
  - Forma del objeto en respuesta: campos `{ id, code, description, active, thirdPartyId, syncedAt, createdAt, updatedAt }` (REQ-SHAPE-CAT-1).
- [ ] 4.12 Crear `src/infrastructure/http/routes/iclass-admin.routes.ts` con las dos rutas, `requireAdmin` middleware, zod validación, wiring a `SyncIClassSoTypes` y `ListIClassSoTypes` (design § Routes).
- [ ] 4.13 **(TEST ROJO)** Extender `src/__tests__/infrastructure/projects.routes.test.ts`:
  - `PATCH /api/projects/:id { iclassSoTypeId: "t-2" }` activo → 200 con `iclassSoType.code` en respuesta (REQ-PROJ-6, REQ-PROJ-8).
  - `PATCH /api/projects/:id { iclassSoTypeId: null }` → 200 con `iclassSoType: null` (REQ-PROJ-5).
  - `PATCH /api/projects/:id { iclassSoTypeId: "t-999" }` inexistente → 404 `ICLASS_SO_TYPE_NOT_FOUND` (REQ-PROJ-4).
  - `PATCH /api/projects/:id { iclassSoTypeId: "t-1" }` inactivo → 422 `ICLASS_SO_TYPE_INACTIVE` (REQ-PROJ-3).
  - `PATCH /api/projects/:id { iclassSoTypeId: 123 }` tipo inválido → 400 `VALIDATION_ERROR` (REQ-PROJ-7).
  - Todos los endpoints GET de Project incluyen `iclassSoTypeId` e `iclassSoType` en la respuesta (REQ-PROJ-8).
- [ ] 4.14 Extender el schema Zod `UpdateProjectSchema` en `src/application/dto/projects.dto.ts` con `iclassSoTypeId: z.string().uuid().nullable().optional()` (REQ-PROJ-7).
- [ ] 4.15 Integrar `AssignIClassSoTypeToProject` dentro del use case `UpdateProject` (o en la route handler) cuando `dto.iclassSoTypeId !== undefined`; inyectar `IClassSoTypeRepository` en el punto de wiring correspondiente (design § Modified PATCH /api/projects/:id).
- [ ] 4.16 Extender `src/__tests__/infrastructure/scheduling.routes.test.ts` con los tres nuevos errores en el endpoint de move-to-stage (flag ON):
  - 422 `MISSING_PROJECT_FOR_ICLASS` — task sin project.
  - 422 `MISSING_ICLASS_MAPPING` con `projectTitle` en body — project sin mapeo.
  - Verificar que el existing happy path sigue funcionando (task tiene project + tipo activo).
- [ ] 4.17 Wirear todo en `src/infrastructure/http/app.ts`: instanciar `PrismaIClassSoTypeRepository`, pasarlo al router de iclass-admin y al wiring de `UpdateProject`/`AssignIClassSoTypeToProject`; montar `iclass-admin.routes.ts` en `/api/admin/iclass`.
- [ ] 4.18 **(TEST VERDE)** Todos los tests de las tareas 4.11–4.16 pasan. `npm test` verde completo.

### Gate Fase 4

`npm test` verde. `tsc --noEmit` verde.

**Commit:**
```
feat(iclass): Prisma adapters, IClassClient listServiceOrderTypes, admin routes for SO type catalog and Project mapping
```
**Files to `git add`:**
```
src/infrastructure/adapters/iclass/IClassClient.ts
src/infrastructure/adapters/prisma/PrismaIClassSoTypeRepository.ts
src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts
src/infrastructure/adapters/prisma/PrismaProjectRepository.ts
src/infrastructure/http/routes/iclass-admin.routes.ts
src/infrastructure/http/app.ts
src/application/dto/projects.dto.ts
src/application/use-cases/UpdateProject.ts
src/__tests__/infrastructure/IClassClient.test.ts
src/__tests__/infrastructure/iclass-admin.routes.test.ts
src/__tests__/infrastructure/projects.routes.test.ts
src/__tests__/infrastructure/scheduling.routes.test.ts
```

---

## FASE 5 — Cleanup: eliminar `ICLASS_DEFAULT_SO_TYPE`

- [ ] 5.1 En `src/infrastructure/adapters/iclass/IClassClient.ts`: eliminar campo `defaultSoType: string` de `IClassClientOptions` y del cuerpo de la clase; eliminar la asignación `this.defaultSoType = opts.defaultSoType` en el constructor (REQ-CONFIG-2, design § Removal of ICLASS_DEFAULT_SO_TYPE).
- [ ] 5.2 En `src/infrastructure/http/iclass.factory.ts:16`: eliminar `defaultSoType` del destructuring de `config.iclass` y del argumento del constructor de `IClassClient` (design § Factory).
- [ ] 5.3 En `src/infrastructure/config.ts:65`: eliminar la línea `defaultSoType: process.env.ICLASS_DEFAULT_SO_TYPE ?? ''` del objeto `config.iclass` (REQ-CONFIG-2).
- [ ] 5.4 En `env.example:44`: eliminar la línea `ICLASS_DEFAULT_SO_TYPE=` (REQ-CONFIG-2).
- [ ] 5.5 En `.github/workflows/deploy.yml:53`: eliminar la línea `-e ICLASS_DEFAULT_SO_TYPE="${{ secrets.ICLASS_DEFAULT_SO_TYPE }}" \` (REQ-CONFIG-2, AD-7).
- [ ] 5.6 En `docs/iclass-integration.md:23`: eliminar la fila `ICLASS_DEFAULT_SO_TYPE` de la tabla de variables y actualizar la descripción del flujo para reflejar la resolución desde Project (design § Removal).
- [ ] 5.7 En `src/__tests__/infrastructure/IClassClient.test.ts`: remover `defaultSoType: 'INSTALL'` (o el valor que se esté usando) de los argumentos de construcción del cliente en los tests; verificar que los tests siguen pasando (design § Removal table).
- [ ] 5.8 `tsc --noEmit` — DEBE fallar en compile si algún lugar todavía pasa `defaultSoType` al constructor (REQ-CONFIG-2, escenario TypeScript compilation rejects). Corregir cualquier referencia que quede.

### Gate Fase 5

`npm test` verde. `tsc --noEmit` verde. `rg "defaultSoType" src/` sin resultados (salvo comentarios históricos si los hubiera, verificar).

**Commit:**
```
feat(iclass): remove ICLASS_DEFAULT_SO_TYPE env var and defaultSoType from IClassClient
```
**Files to `git add`:**
```
src/infrastructure/adapters/iclass/IClassClient.ts
src/infrastructure/http/iclass.factory.ts
src/infrastructure/config.ts
env.example
.github/workflows/deploy.yml
docs/iclass-integration.md
src/__tests__/infrastructure/IClassClient.test.ts
```

---

## FASE 6 — Pre-deploy hand-off

- [ ] 6.1 Documentar el procedimiento de operator en `docs/iclass-integration.md` (nueva sección "Rollout procedure"):
  1. Asegurarse de que la migración se aplicó (CI lo hace antes del start).
  2. Con el flag `iclass-integration` todavía OFF, ejecutar `POST /api/admin/iclass/so-types/sync` — verificar que devuelve 26 tipos activos.
  3. Para cada Project activo que vaya a usar "Enviar a IClass", ejecutar `PATCH /api/projects/:id { iclassSoTypeId: "<id>" }` con el tipo correspondiente (usar `GET /api/admin/iclass/so-types?active=true` para el listado).
  4. Verificar en la lista de Projects que todos los activos tienen `iclassSoType != null`.
  5. Activar el flag: `PATCH /api/admin/feature-flags/iclass-integration { "enabled": true }`.
  6. Probar un envío de tarea a IClass desde el front con un Project mapeado.
- [ ] 6.2 (Opcional / fuera de scope de código) Smoke test contra IClass staging si disponible; en caso de IPNX prod-only, omitir.

**Commit:**
```
docs(iclass): add rollout procedure for SO type mapping
```
**Files to `git add`:**
```
docs/iclass-integration.md
```

---

## Verify Checklist

Antes de hacer push a prod, chequear estos red flags:

- [ ] V.1 Migración presente: `prisma/migrations/<timestamp>_iclass_so_type_catalog/migration.sql` existe en el repo.
- [ ] V.2 `ICLASS_DEFAULT_SO_TYPE` no aparece en ningún archivo de `src/`: `rg "ICLASS_DEFAULT_SO_TYPE" src/` → sin resultados.
- [ ] V.3 `defaultSoType` no aparece en `src/infrastructure/` (salvo tests ya actualizados o comentarios): `rg "defaultSoType" src/infrastructure/` → sin resultados en código de producción.
- [ ] V.4 `tsc --noEmit` verde — el compilador rechaza cualquier llamada a `createServiceOrder` sin `soType` (REQ-CONFIG-2 escenario compilación).
- [ ] V.5 `npm test` verde — sin tests rotos.
- [ ] V.6 El endpoint `POST /api/admin/iclass/so-types/sync` requiere admin auth: verificar que retorna 401 sin token.
- [ ] V.7 `SendTaskToIClass` con task sin project retorna 422 `MISSING_PROJECT_FOR_ICLASS` (cubierto por test de routes Fase 4).
- [ ] V.8 `SendTaskToIClass` con project sin mapeo retorna 422 `MISSING_ICLASS_MAPPING` con `projectTitle` (cubierto por test de routes Fase 4).
- [ ] V.9 Flag `iclass-integration` sigue OFF en prod hasta que el operator complete el procedimiento de rollout (Fase 6).

---

## Deploy Notes

**Lockstep deploy (AD-7):** La migración (nueva tabla `IClassSoType` + columna `Project.iclassSoTypeId` nullable) y la remoción de `ICLASS_DEFAULT_SO_TYPE` van en la MISMA PR y el MISMO push. CI corre `prisma migrate deploy` antes de levantar el código nuevo. No hay ventana intermedia rota porque la columna FK es nullable y el código nuevo no lee `defaultSoType`.

**Pre-deploy operator steps (OBLIGATORIOS antes de activar el flag):**
1. Aplicar migración (automático en CI).
2. Ejecutar sync del catálogo: `POST /api/admin/iclass/so-types/sync`.
3. Mapear cada Project activo vía `PATCH /api/projects/:id { iclassSoTypeId }`.
4. Activar flag `iclass-integration`.

**Rollback:** La FK es nullable y la tabla es aditiva. Para rollback: revertir el código (git revert), restaurar `ICLASS_DEFAULT_SO_TYPE` en el deploy. Las columnas/tabla nuevas no afectan el código viejo. Opcionalmente limpiar con `prisma migrate resolve`.
