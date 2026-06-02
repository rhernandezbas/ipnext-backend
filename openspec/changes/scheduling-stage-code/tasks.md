# Tasks -- scheduling-stage-code

Flujo TDD ESTRICTO: escribir el test en ROJO primero, luego el codigo que lo pone en VERDE,
luego refactor si aplica. Cada commit debe quedar con `tsc --noEmit` 0 errores y sin
regresiones en la suite antes de avanzar al siguiente.

Trazabilidad de requisitos:
  REQ-CODE-1..5  -> spec stage-stable-code
  REQ-LOGIC-1   -> spec stage-stable-code
  REQ-BACKFILL-1 -> spec stage-stable-code
  REQ-DTO-1      -> spec stage-stable-code
  REQ-RBAC-1..2  -> spec stage-stable-code
  REQ-DIP-1      -> spec stage-stable-code
  REQ-MOVE-STAGE-1, REQ-MOVE-OS-1  -> spec scheduling delta
  REQ-BACKFILL-STAGE-1              -> spec scheduling delta
  REQ-INGEST-STAGE-1                -> spec scheduling delta
  REQ-LIST-ICLASS-1                 -> spec scheduling delta

---

## Commit 1 -- feat(scheduling): Stage.code schema + migration backfill idempotente

> No hay test Jest en este commit. El gate es: `prisma validate` sin errores, SQL bien
> formado y aplicable en prod via `migrate deploy`. NO correr `migrate dev`.

### Schema Prisma

- [x] **T-01** Agregar `code String` al modelo `Stage` en `prisma/schema.prisma`
  - Agregar el campo `code  String` (sin `@default`; el valor llega del use case / backfill).
  - Agregar `@@unique([workflowId, code])` debajo del `@@index([workflowId, order])` existente.
  - Aceptacion: `npx prisma validate` pasa sin errores; el campo queda en el schema con el
    constraint de unicidad.
  - Traza: REQ-CODE-3.

### Migration SQL

- [x] **T-02** Generar el esqueleto del archivo de migration con `prisma migrate diff`
  - Ejecutar (solo para obtener el ADD COLUMN + index generado automaticamente):
    ```
    npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
      --to-schema-datamodel prisma/schema.prisma --script
    ```
  - Crear el directorio `prisma/migrations/20260603000000_stage_code/` y el archivo
    `migration.sql` con el SQL generado como punto de partida.
  - NO aplicar con `migrate dev`. El archivo es para edicion manual y deploy posterior.
  - Aceptacion: el archivo existe en el path correcto; el SQL contiene al menos
    `ALTER TABLE "Stage" ADD COLUMN "code" TEXT` y el `CREATE UNIQUE INDEX`.

- [x] **T-03** Insertar los 3 pasos en `migration.sql` (ADD nullable -> backfill DO $$ -> NOT NULL + index)
  - Paso 1: `ALTER TABLE "Stage" ADD COLUMN "code" TEXT;` (sin NOT NULL para que el
    backfill pueda correr).
  - Paso 2: bloque `DO $$ ... END $$;` idempotente (solo toca filas con `code IS NULL`)
    con el mapa canonico de los 11 stages y slug fallback + desambiguacion por sufijo
    numerico dentro del workflow. Ver SQL completo en `design.md` seccion "Migration SQL".
  - Paso 3: `ALTER TABLE "Stage" ALTER COLUMN "code" SET NOT NULL;` seguido del
    `CREATE UNIQUE INDEX "Stage_workflowId_code_key" ON "Stage"("workflowId", "code");`.
  - Verificar que el bloque DO $$ cubra TODOS los stages antes del SET NOT NULL (mismo
    archivo = misma transaccion de migration -> no puede quedar a medias).
  - Aceptacion: el SQL es aplicable en una copia de la DB sin registros en `code`;
    re-ejecutar el UPDATE idempotente no altera codes ya asignados (condicion `WHERE "code"
    IS NULL`).
  - Traza: REQ-BACKFILL-1.

- [x] **T-04** Gate de calidad del commit 1
  - `npx prisma validate` pasa.
  - `tsc --noEmit` pasa con 0 errores (el schema aun no tiene `code` en la entidad TS;
    ese es el commit 2).
  - Revision visual: el SQL contiene los 3 pasos en orden correcto.

---

## Commit 2 -- feat(scheduling): code en entity + getStageByCode en ports e in-memory (TDD)

### Tests en ROJO primero

- [x] **T-05** [RED] Ampliar / crear tests del InMemoryStageRepository
  - Archivo: `src/__tests__/infrastructure/InMemoryStageRepository.test.ts` (crear si no
    existe; ampliar si ya existe).
  - Scenario: `add` con `code` lo persiste y `findByCode(code, workflowId)` lo devuelve.
  - Scenario: `findByCode` con workflowId distinto devuelve `null` (unicidad por workflow).
  - Scenario: `add` sin `code` falla en compilacion (TS obliga el campo).
  - Correr `npm test -- --testPathPattern=InMemoryStageRepository`: debe FALLAR (rojo).
  - Traza: REQ-CODE-4.

- [x] **T-06** [RED] Ampliar tests del InMemorySchedulingRepository
  - Archivo: `src/__tests__/infrastructure/InMemorySchedulingRepository.test.ts` (crear o
    ampliar).
  - Scenario: `getStageByCode(code, workflowId)` devuelve el stage correcto.
  - Scenario: `getStageByCode` con code inexistente devuelve `null`.
  - Scenario: `listTasksInIClassStage(stageCode)` filtra por `code`, no por `name` (pasar
    un stage con `name` distinto pero mismo `code` y verificar que aparece en el resultado).
  - Correr: debe FALLAR (rojo).
  - Traza: REQ-CODE-4, REQ-LIST-ICLASS-1.

### Codigo que pone en VERDE

- [x] **T-07** [GREEN] Agregar `code: string` a la entidad `Stage`
  - Archivo: `src/domain/entities/workflow.ts`.
  - Agregar el campo `code: string` en la interfaz `Stage`.
  - Aceptacion: `tsc --noEmit` surfacea errores en los adapters/use cases que construyen
    `Stage` sin `code` -- eso es esperado y se va resolviendo en las tareas siguientes.

- [x] **T-08** [GREEN] Agregar `getStageByCode` y deprecar `getStageByName` en ports
  - Archivo: `src/domain/ports/SchedulingRepository.ts`.
  - Agregar firma: `getStageByCode(code: string, workflowId: string): Promise<Stage | null>`.
  - Renombrar parametro de `listTasksInIClassStage` de `stageName` a `stageCode` (firma
    del port).
  - Marcar `getStageByName` con `/** @deprecated Use getStageByCode. */`.
  - Archivo: `src/domain/ports/StageRepository.ts`.
  - Agregar `findByCode(code: string, workflowId: string): Promise<Stage | null>`.
  - Actualizar la firma de `add` para incluir `code` en el objeto de datos:
    `add(workflowId: string, data: Pick<Stage, 'name' | 'code' | 'category' | 'order'>): Promise<Stage>`.
  - Aceptacion: `tsc --noEmit` surfacea errores en implementors -- esperado.
  - Traza: REQ-CODE-4, REQ-CODE-5.

- [x] **T-09** [GREEN] Implementar `findByCode` y actualizar `add` en InMemoryStageRepository
  - Archivo: `src/infrastructure/adapters/in-memory/InMemoryStageRepository.ts`.
  - `add`: persistir `code` desde `data.code`; incluir en el objeto almacenado.
  - `findByCode(code, workflowId)`: buscar en la coleccion interna por ambos campos.
  - Incluir `code` en todos los objetos `Stage` retornados (mappers existentes).
  - Aceptacion: tests T-05 pasan (verde).

- [x] **T-10** [GREEN] Implementar `getStageByCode` y `listTasksInIClassStage` por code en InMemorySchedulingRepository
  - Archivo: `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts`.
  - `getStageByCode(code, workflowId)`: delegar en `stageRepo.findByCode(code, workflowId)`.
  - `listTasksInIClassStage(stageCode)`: resolver el stage por `code` (sin workflowId;
    buscar el primero que coincida en cualquier workflow) y filtrar tasks por `stageId`.
  - `getStageByName` queda funcional pero deprecado (no borrar).
  - Incluir `code` en todos los stages retornados por `getStageByName` y `getInitialStage`.
  - Aceptacion: tests T-06 pasan (verde).

- [x] **T-11** Gate de calidad del commit 2
  - `tsc --noEmit` con 0 errores (los adapters Prisma aun pueden no compilar si no se
    actualizaron; actualizar los mappers minimos para que compilen sin logica nueva).
  - Tests T-05 y T-06 en verde; ningun test previo roto.

---

## Commit 3 -- refactor(scheduling): resolver stages por code en logica de negocio (TDD)

> Incluye el fix del BUG de `bootstrapGestionRealIngest` (`"Pendiente"` inexistente en seed).

### Tests en ROJO primero

- [ ] **T-12** [RED] Actualizar fixtures/asertos en SendTaskToIClass.test.ts
  - Archivo: `src/__tests__/application/SendTaskToIClass.test.ts`.
  - Cambiar fixture de stage: agregar `code: "registered_in_iclass"` al objeto Stage usado
    en el test; el mock de `getStageByCode` debe retornar ese stage.
  - Cambiar aserto: verificar que `getStageByCode` (no `getStageByName`) fue llamado con
    `("registered_in_iclass", workflowId)`.
  - Correr el test: debe FALLAR (el use case aun llama `getStageByName`).
  - Traza: REQ-LOGIC-1, REQ-MOVE-OS-1.

- [ ] **T-13** [RED] Actualizar fixtures/asertos en MoveTaskToStage.test.ts
  - Archivo: `src/__tests__/application/MoveTaskToStage.test.ts`.
  - Agregar `code: "send_to_iclass"` al stage fixture de "Enviar a IClass".
  - Verificar que la deteccion IClass compara `stage.code === "send_to_iclass"` (no `name`).
  - Scenario extra: stage con `name: "Despachar a IClass"` pero `code: "send_to_iclass"`
    DEBE disparar la integracion (rename-safe).
  - Correr: debe FALLAR.
  - Traza: REQ-MOVE-STAGE-1, REQ-LOGIC-1.

- [ ] **T-14** [RED] Actualizar fixtures/asertos en BackfillClosedServiceOrders.test.ts
  - Archivo: `src/__tests__/application/BackfillClosedServiceOrders.test.ts`.
  - Agregar `code: "registered_in_iclass"` a los stages fixtures del in-flight.
  - Verificar que `listTasksInIClassStage` se llama con `"registered_in_iclass"` (stageCode).
  - Si el test acepta `opts.inFlightStageName`, renombrarlo a `opts.inFlightStageCode`.
  - Correr: debe FALLAR.
  - Traza: REQ-BACKFILL-STAGE-1, REQ-LIST-ICLASS-1.

- [ ] **T-15** [RED] Actualizar fixtures en IClassClosureScheduler.test.ts
  - Archivo: `src/__tests__/infrastructure/IClassClosureScheduler.test.ts`.
  - Agregar `code` a los stages en los fixtures del scheduler.
  - Correr: debe FALLAR si el test usa stages sin `code` y el type lo exige.
  - Traza: REQ-LIST-ICLASS-1.

- [ ] **T-16** [RED] Renombrar / ampliar getStageByName.workflow.test.ts -> getStageByCode
  - Archivo origen: `src/__tests__/infrastructure/getStageByName.workflow.test.ts`.
  - Renombrar a `getStageByCode.workflow.test.ts`.
  - Agregar scenarios que usan `getStageByCode(code, workflowId)` contra el InMemory adapter.
  - Mantener los scenarios de `getStageByName` comentados con `@deprecated` para referencia.
  - Correr: los nuevos scenarios deben FALLAR (aun no hay impl Prisma; el in-memory ya esta
    verde del commit 2, pero si el test usa algo que falta, fallara).
  - Traza: REQ-CODE-4, REQ-CODE-5.

- [ ] **T-17** [RED] Actualizar IngestClosedServiceOrders.test.ts
  - Archivo: `src/__tests__/application/IngestClosedServiceOrders.test.ts`.
  - Agregar `code` al stage fixture; verificar que el ingest usa `getStageByCode`.
  - Correr: debe FALLAR.
  - Traza: REQ-INGEST-STAGE-1.

### Codigo que pone en VERDE

- [ ] **T-18** [GREEN] Refactorizar SendTaskToIClass.ts
  - Archivo: `src/application/use-cases/SendTaskToIClass.ts`.
  - Reemplazar `REGISTRADO_STAGE_NAME = "Registrado en IClass"` por
    `REGISTERED_IN_ICLASS_CODE = "registered_in_iclass"`.
  - Cambiar la llamada `getStageByName(REGISTRADO_STAGE_NAME, workflowId)` por
    `getStageByCode(REGISTERED_IN_ICLASS_CODE, workflowId!)`.
  - `StageNotFoundError` ahora reporta el code en lugar del name.
  - Verificar DIP: el archivo NO importa nada de `@infrastructure/*`.
  - Aceptacion: test T-12 pasa (verde).
  - Traza: REQ-LOGIC-1, REQ-DIP-1.

- [ ] **T-19** [GREEN] Refactorizar MoveTaskToStage.ts
  - Archivo: `src/application/use-cases/MoveTaskToStage.ts`.
  - Reemplazar `ENVIAR_A_ICLASS_STAGE_NAME = "Enviar a IClass"` por
    `SEND_TO_ICLASS_CODE = "send_to_iclass"`.
  - Cambiar la comparacion `stage.name === ENVIAR_A_ICLASS_STAGE_NAME` por
    `stage.code === SEND_TO_ICLASS_CODE`.
  - `stage` ya viene de `getById` que devuelve la entity con `code`.
  - Verificar DIP: sin imports de `@infrastructure/*`.
  - Aceptacion: test T-13 pasa (verde).
  - Traza: REQ-MOVE-STAGE-1, REQ-DIP-1.

- [ ] **T-20** [GREEN] Refactorizar BackfillClosedServiceOrders.ts
  - Archivo: `src/application/use-cases/BackfillClosedServiceOrders.ts`.
  - Reemplazar `DEFAULT_IN_FLIGHT_STAGE = "Registrado en IClass"` por
    `DEFAULT_IN_FLIGHT_STAGE_CODE = "registered_in_iclass"`.
  - Renombrar el campo de opciones `inFlightStageName` -> `inFlightStageCode` y el campo
    privado correspondiente.
  - Llamar `listTasksInIClassStage(this.inFlightStageCode)`.
  - Aceptacion: tests T-14 y T-15 pasan (verde).
  - Traza: REQ-BACKFILL-STAGE-1, REQ-LIST-ICLASS-1.

- [ ] **T-21** [GREEN / BUG FIX] Refactorizar bootstrapGestionRealIngest.ts
  - Archivo: `src/infrastructure/scheduling/bootstrapGestionRealIngest.ts`.
  - BUG ACTUAL: el modulo busca el stage `"Pendiente"` por nombre; ese stage NO existe en el
    seed canonico -> `defaultStageId` queda `""` en silencio.
  - FIX: resolver el stage inicial del workflow usando `getStageByCode("pendiente", workflowId)`
    si hay un workflowId disponible; si no, usar `getInitialStage(workflowId)` del
    `SchedulingRepository` (primer stage por `order`) como fallback real.
  - Definir `PENDING_STAGE_CODE = "pendiente"` como constante nombrada.
  - NO hardcodear string literal de nombre de stage.
  - Si el stage `"pendiente"` no existe en el workflow, loguear un warning y caer al
    `getInitialStage` del workflow (nunca dejar `defaultStageId` vacio en silencio).
  - Aceptacion: test T-17 pasa (verde); el archivo NO contiene el literal `"Pendiente"`.
  - Traza: REQ-INGEST-STAGE-1, REQ-LOGIC-1.

- [ ] **T-22** Gate de calidad del commit 3
  - `rg '"Registrado en IClass"\|"Enviar a IClass"\|"Pendiente"' src/application src/infrastructure/scheduling`
    debe retornar 0 matches (no quedan literales de nombre de stage en logica de negocio).
  - `tsc --noEmit` con 0 errores.
  - Suite completa `npm test`: cero fallos; ninguna regresion en tests no relacionados.

---

## Commit 4 -- feat(scheduling): code en DTO de salida + autogeneracion en AddStageToWorkflow (TDD)

### Tests en ROJO primero

- [ ] **T-23** [RED] Ampliar WorkflowUseCases.test.ts -- code autogenerado al crear stage
  - Archivo: `src/__tests__/application/WorkflowUseCases.test.ts`.
  - Scenario: `AddStageToWorkflow.execute` con `name: "En Revision"` -> el stage retornado
    tiene `code: "en_revision"`.
  - Scenario: `AddStageToWorkflow.execute` con `name: "Revision"` en workflow que ya tiene
    un stage `code: "revision"` -> el nuevo stage recibe `code: "revision_2"`.
  - Scenario RENAME-SAFE: crear stage, cambiar `name` via `UpdateStage` (si existe), verificar
    que `code` permanece igual.
  - Scenario: enviar `code` en el input de creacion es ignorado (el use case autogenera el suyo).
  - Correr: debe FALLAR.
  - Traza: REQ-CODE-1, REQ-CODE-2.

- [ ] **T-24** [RED] Test de integracion de ruta -- DTO incluye code
  - Archivo: `src/__tests__/infrastructure/scheduling.routes.test.ts` (o el test de
    workflows.routes si existe separado).
  - Scenario: `POST /api/workflows/:id/stages` con body valido retorna 201 con `code` en el
    body de respuesta.
  - Scenario: `GET /api/workflows` retorna stages con campo `code` no nulo en cada stage.
  - Scenario: el body de `POST` puede incluir `code` custom -> es ignorado; el `code` del
    response es el slug autogenerado.
  - Correr: debe FALLAR.
  - Traza: REQ-DTO-1, REQ-CODE-1.

### Codigo que pone en VERDE

- [ ] **T-25** [GREEN] Agregar helper `slugifyStageCode` y logica de autogeneracion en AddStageToWorkflow.ts
  - Archivo: `src/application/use-cases/AddStageToWorkflow.ts`.
  - Agregar funcion pura `slugifyStageCode(name: string): string` (ver algoritmo en
    `design.md` seccion "Creacion de stage: autogeneracion del code").
  - En `execute()`, luego de validar nombre duplicado: calcular `base = slugifyStageCode(name)`,
    construir el `Set` de codes existentes del workflow, iterar hasta encontrar un code libre
    (sufijo `_2`, `_3`, ...).
  - Pasar `{ ...data, code }` a `this.stages.add(workflowId, ...)`.
  - `CreateStageSchema` NO se modifica: si el cliente envia `code`, se ignora (no forma parte
    del schema de input).
  - Verificar DIP: sin imports de `@infrastructure/*`.
  - Aceptacion: test T-23 pasa (verde).
  - Traza: REQ-CODE-1, REQ-CODE-2, REQ-DIP-1.

- [ ] **T-26** [GREEN] Agregar `code` al mapper `toStage` del adapter Prisma y al PrismaWorkflowRepository
  - Archivo: `src/infrastructure/adapters/prisma/PrismaWorkflowRepository.ts`.
  - En la funcion `toStage` (o equivalente), agregar `code: row.code`.
  - Archivo: `src/infrastructure/adapters/prisma/PrismaStageRepository.ts`.
  - Incluir `code: row.code` en todos los objetos `Stage` mapeados; incluir `code` en los
    datos de `create` (viene del use case).
  - Archivo: `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts`.
  - Agregar implementacion de `getStageByCode(code, workflowId)`: `findFirst({ where: { code, workflowId } })`.
  - Actualizar `listTasksInIClassStage` para filtrar por `code` en lugar de `name`.
  - Incluir `code` en todos los mappers de stage existentes (`getStageByName`,
    `getInitialStage`, etc.) para que compilen y sean consistentes.
  - Aceptacion: `tsc --noEmit` con 0 errores; test T-24 pasa (verde).
  - Traza: REQ-DTO-1, REQ-CODE-4.

- [ ] **T-27** Gate de calidad del commit 4
  - `tsc --noEmit` 0 errores.
  - Tests T-23 y T-24 en verde; suite completa sin regresiones.
  - Verificar manualmente que el DTO retornado por `GET /api/workflows` contiene `code` en
    cada stage (via `npm run dev` + curl, o inspeccion del test de integracion).

---

## Commit 5 -- feat(scheduling): seed setea code en los 11 stages canonicos

> No hay test Jest automatizado. El gate es: seed idempotente y codes presentes en DB.

- [ ] **T-28** Actualizar `prisma/seed.ts` con el mapa name -> code
  - Archivo: `prisma/seed.ts`.
  - Para cada uno de los 11 stages canonicos, agregar `code: "<code>"` segun el mapa del
    design (ver tabla en `design.md` seccion "Mapa canonico name -> code (los 11 del seed)"):
    - `Nuevo` -> `nuevo`
    - `Confirmado` -> `confirmado`
    - `Pospuesta` -> `pospuesta`
    - `No Factible` -> `no_factible`
    - `Enviar a IClass` -> `send_to_iclass`
    - `Registrado en IClass` -> `registered_in_iclass`
    - `Notificado` -> `notificado`
    - `En progreso` -> `en_progreso`
    - `Instalado` -> `instalado`
    - `Hecho` -> `hecho`
    - `Anulado-Cancelado` -> `anulado_cancelado`
  - El seed usa `upsert` (o equivalente); agregar `code` al objeto de datos de cada stage.
  - Verificar que el seed es idempotente: si ya existe el stage con ese `code`, no lo duplica
    ni rompe el `@@unique([workflowId, code])`.
  - Aceptacion: `npm run prisma:seed` corre sin errores; ejecutarlo dos veces seguidas no
    lanza error de unicidad.
  - Traza: REQ-BACKFILL-1.

- [ ] **T-29** Asignar permiso `scheduling.manage` al rol `admin` en el seed RBAC
  - Archivo: `prisma/seed.ts` (seccion de seed de permisos / roles).
  - El rol `admin` debe recibir la accion `manage` en el modulo `scheduling`.
  - `super_admin` ya tiene `*` -> no necesita cambio.
  - Aceptacion: re-run del seed es idempotente; `admin` puede usar las rutas de
    workflows/stages (validado en el commit 6).
  - Traza: REQ-RBAC-1 (prerequisito de coordinacion).

- [ ] **T-30** Gate de calidad del commit 5
  - `tsc --noEmit` 0 errores.
  - Suite completa sin regresiones (el seed no tiene tests automaticos propios; los tests de
    integracion existentes no usan el seed real).

---

## Commit 6 -- feat(scheduling): RBAC scheduling.manage/read en rutas de workflows/stages (TDD)

### Tests en ROJO primero

- [ ] **T-31** [RED] Escribir tests de integracion RBAC para workflows.routes
  - Archivo: `src/__tests__/infrastructure/workflows.routes.rbac.test.ts` (crear nuevo).
  - Usar supertest + `InMemorySchedulingRepository` + `FakeAuthProvider` + `InMemoryRbacRepository`
    (o el helper de permisos ya usado en otros tests del repo).
  - Scenarios obligatorios (uno por ruta mutante, al menos):
    - `POST /api/workflows` sin token -> 401.
    - `POST /api/workflows` con token valido pero sin `scheduling.manage` -> 403 con
      `{ "code": "PERMISSION_DENIED" }`.
    - `POST /api/workflows` con token y `scheduling.manage` -> 201 (o al menos no 401/403).
    - `DELETE /api/workflows/:id` sin permiso -> 403.
    - `POST /api/workflows/:id/stages` sin permiso -> 403.
    - `GET /api/workflows` sin `scheduling.read` -> 403.
    - `GET /api/workflows` con `scheduling.read` -> 200.
    - `super_admin` en `POST /api/workflows` -> no 401 ni 403 (short-circuit).
  - Correr: debe FALLAR (las rutas aun no tienen `requirePerm`).
  - Traza: REQ-RBAC-1, REQ-RBAC-2.

### Codigo que pone en VERDE

- [ ] **T-32** [GREEN] Agregar parametro `requirePerm` a `createWorkflowsRouter`
  - Archivo: `src/infrastructure/http/routes/workflows.routes.ts`.
  - Seguir el patron de `createGestionRealSyncRouter`: la funcion factory recibe
    `requirePerm: (module: RbacModuleCode, action: PermissionAction) => RequestHandler`
    como segundo parametro (o primero, segun la firma existente; ser consistente).
  - Encadenar despues de `auth` en cada ruta:
    - GET `workflows` y GET `workflows/:id` -> `requirePerm('scheduling', 'read')`.
    - POST `workflows` -> `requirePerm('scheduling', 'manage')`.
    - PUT/PATCH/DELETE `workflows/:id` -> `requirePerm('scheduling', 'manage')`.
    - POST `workflows/:id/stages` -> `requirePerm('scheduling', 'manage')`.
    - PUT `workflows/:id/stages/reorder` (o `/order`) -> `requirePerm('scheduling', 'manage')`.
    - DELETE `workflows/:id/stages/:stageId` -> `requirePerm('scheduling', 'manage')`.
    - PATCH `workflows/:id/stages/:stageId/color` -> `requirePerm('scheduling', 'manage')`.
  - Si `project-categories` / `project-types` viven en el mismo router, aplicarles el mismo
    criterio (GET -> read, mutaciones -> manage) para consistencia.
  - Aceptacion: `tsc --noEmit` pasa; las firmas de las rutas son correctas.
  - Traza: REQ-RBAC-1, REQ-RBAC-2.

- [ ] **T-33** [GREEN] Actualizar el wiring de `createWorkflowsRouter` en app.ts
  - Archivo: `src/infrastructure/http/app.ts`.
  - Pasar `requirePerm` como argumento a `createWorkflowsRouter` (linea donde se instancia
    el router; ver referencia en `design.md` seccion "RBAC en workflows.routes.ts" -> wiring
    app.ts:890).
  - Verificar que `requirePerm` ya existe en el scope de `app.ts` (reutilizar el factory ya
    usado por otros routers como `createGestionRealSyncRouter`).
  - Aceptacion: `tsc --noEmit` 0 errores; `npm run dev` levanta sin errores.
  - Traza: REQ-RBAC-1.

- [ ] **T-34** Gate de calidad final del commit 6 (cierre del change)
  - Tests T-31 en verde; ningun test previo roto.
  - `tsc --noEmit` 0 errores.
  - Suite COMPLETA `npm test`: cero fallos; sin regresiones.
  - `rg '"Registrado en IClass"\|"Enviar a IClass"\|"Pendiente"' src/application src/infrastructure/scheduling`
    retorna 0 matches.
  - Verificar DIP: `rg 'from.*@infrastructure' src/application/` retorna 0 matches relevantes.
  - Revisar Success Criteria de `proposal.md` y marcar los cumplidos.

---

## Resumen de trazabilidad REQ -> Tasks

| Requisito | Tasks |
|-----------|-------|
| REQ-CODE-1 (code inmutable) | T-23, T-25 |
| REQ-CODE-2 (slug autogenerado) | T-23, T-25 |
| REQ-CODE-3 (unique por workflow) | T-01, T-03 |
| REQ-CODE-4 (getStageByCode en ports) | T-05, T-06, T-08, T-09, T-10, T-26 |
| REQ-CODE-5 (deprecar getStageByName) | T-08, T-10 |
| REQ-LOGIC-1 (resolver por code, no name) | T-12..T-21 |
| REQ-BACKFILL-1 (migration idempotente) | T-02, T-03, T-28 |
| REQ-DTO-1 (code en DTO de salida) | T-23, T-24, T-26 |
| REQ-RBAC-1 (manage en mutaciones) | T-29, T-31, T-32, T-33 |
| REQ-RBAC-2 (read en GETs) | T-31, T-32 |
| REQ-DIP-1 (no infra en application) | T-18, T-19, T-20, T-25, T-34 |
| REQ-MOVE-STAGE-1 | T-13, T-19 |
| REQ-MOVE-OS-1 | T-12, T-18 |
| REQ-BACKFILL-STAGE-1 | T-14, T-20 |
| REQ-INGEST-STAGE-1 (bug fix Pendiente) | T-17, T-21 |
| REQ-LIST-ICLASS-1 (stageCode en listTasks) | T-06, T-10, T-14, T-20, T-26 |
