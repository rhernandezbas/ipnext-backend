# Tasks -- iclass-manual-node-resend

Flujo TDD ESTRICTO: escribir el test en ROJO primero, luego el codigo que lo pone
en VERDE, luego refactor si aplica. Cada commit debe quedar con `tsc --noEmit`
0 errores y sin regresiones en la suite antes de avanzar al siguiente.

Convenciones:
- Tests de use case: adapters in-memory. NUNCA mockear Prisma directamente.
- Naming de adapters: `Prisma{Entity}Repository`, `InMemory{Entity}Repository`.
- DIP: ningun archivo bajo `src/application/` puede importar de `@infrastructure/*`
  ni de `@prisma/client`. Violacion = bug.
- Migrations: aditivas, SQL escrito a mano (sin DB), `migrate deploy` en prod.
- El 4to arg de `SendTaskToIClass` es OPCIONAL: los tests existentes siguen verdes
  sin pasarlo.

Trazabilidad de requisitos:
  REQ-AUDIT-1..6  -> spec iclass-dispatch-audit
  REQ-NODES-1..5  -> spec iclass-nodes-endpoint
  REQ-RESEND-1..10 -> spec iclass-manual-resend
  REQ-RBAC-RESEND-1..5 -> spec rbac-iclass-manual-resend

---

## Commit 1 -- feat(iclass): IClassDispatchAttempt schema + migration aditiva

> No hay test Jest en este commit. El gate es: SQL bien formado y aplicable via
> `migrate deploy`. NO correr `migrate dev`.

### Schema Prisma

- [x] **T-01** Agregar `model IClassDispatchAttempt` a `prisma/schema.prisma`
  - Campos: `id String @id @default(uuid())`, `taskId String`, `outcome String`,
    `errorCode String?`, `errorMessage String?`, `attemptedNodeCode String?`,
    `resolvedNodeCode String?`, `actorId String?`, `createdAt DateTime @default(now())`.
  - Relacion: `task ScheduledTask @relation(fields: [taskId], references: [id], onDelete: Cascade)`.
  - Indice: `@@index([taskId, createdAt])`.
  - Agregar back-relation en `model ScheduledTask`:
    `iclassDispatchAttempts IClassDispatchAttempt[]`.
  - `actorId` es `String?` SIN `@relation` a `RbacUser` (puntero suelto, sin FK dura
    — mismo espiritu que `AuditEvent.actorId`).
  - `outcome` es `String` (sin enum DB; whitelist en la entity TS — AD-2).
  - Aceptacion: `npx prisma validate` pasa sin errores.
  - Traza: REQ-AUDIT-1.

### Migration SQL

- [x] **T-02** Crear `prisma/migrations/20260604000000_iclass_dispatch_attempt/migration.sql`
  - Crear el directorio `prisma/migrations/20260604000000_iclass_dispatch_attempt/`.
  - Escribir el SQL aditivo (sin DB, a mano):
    ```sql
    CREATE TABLE "IClassDispatchAttempt" (
        "id"                TEXT NOT NULL,
        "taskId"            TEXT NOT NULL,
        "outcome"           TEXT NOT NULL,
        "errorCode"         TEXT,
        "errorMessage"      TEXT,
        "attemptedNodeCode" TEXT,
        "resolvedNodeCode"  TEXT,
        "actorId"           TEXT,
        "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "IClassDispatchAttempt_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX "IClassDispatchAttempt_taskId_createdAt_idx"
        ON "IClassDispatchAttempt"("taskId", "createdAt");
    ALTER TABLE "IClassDispatchAttempt"
        ADD CONSTRAINT "IClassDispatchAttempt_taskId_fkey"
        FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    ```
  - Timestamp `20260604000000` (posterior al ultimo: `20260603000000_stage_code`).
  - MUST NOT alterar ninguna tabla existente (solo CREATE TABLE + FK + index).
  - Aceptacion: SQL contiene `CREATE TABLE "IClassDispatchAttempt"`, el indice y la FK.
  - Traza: REQ-AUDIT-1.

- [x] **T-03** Gate de calidad del commit 1
  - `npx prisma validate` pasa sin errores.
  - `tsc --noEmit` pasa con 0 errores.
  - Revision visual: SQL tiene los 3 bloques (CREATE TABLE, CREATE INDEX, ALTER TABLE ADD CONSTRAINT) en orden correcto.
  - Traza: REQ-AUDIT-1.

---

## Commit 2 -- feat(iclass): dispatch-attempt entity + port + adapters (TDD)

### Tests en ROJO primero

- [x] **T-04** [RED] Crear tests del `InMemoryIClassDispatchAttemptRepository`
  - Archivo: `src/__tests__/infrastructure/InMemoryIClassDispatchAttemptRepository.test.ts` (NUEVO).
  - Scenario: `record` con `outcome: "failed"` persiste el attempt; `listByTask(taskId)`
    lo retorna con los campos correctos.
  - Scenario: `listByTask` con `taskId` distinto retorna array vacio.
  - Scenario: `listByTask` con tres attempts para la misma tarea creados en tiempos
    t1 < t2 < t3 los retorna en orden ASC por `createdAt` (mas antiguo primero).
    Nota: el spec dice ASC; el design dice DESC. La decision es ASC (spec manda).
  - Scenario: `record` sin `errorCode` deja `errorCode: null` en el resultado.
  - Correr `npm test -- --testPathPattern=InMemoryIClassDispatchAttemptRepository`:
    debe FALLAR (rojo -- el archivo no existe).
  - Traza: REQ-AUDIT-2, REQ-AUDIT-3.

### Codigo que pone en VERDE

- [x] **T-05** [GREEN] Crear entidad de dominio `IClassDispatchAttempt`
  - Archivo: `src/domain/entities/iclass-dispatch-attempt.ts` (NUEVO).
  - Exportar la constante `ICLASS_DISPATCH_OUTCOMES` como array readonly con:
    `'success' | 'node_not_found' | 'rejected' | 'unavailable' | 'error'`.
  - Exportar el tipo `IClassDispatchOutcome` inferido del array.
  - Exportar la interfaz `IClassDispatchAttempt` con todos los campos tipados
    (id, taskId, outcome, errorCode, errorMessage, attemptedNodeCode,
    resolvedNodeCode, actorId, createdAt como string ISO).
  - Exportar `RecordDispatchAttemptInput` (sin id/createdAt).
  - Aceptacion: `tsc --noEmit` pasa; el archivo compila.
  - Traza: REQ-AUDIT-2.

- [x] **T-06** [GREEN] Crear port `IClassDispatchAttemptRepository`
  - Archivo: `src/domain/ports/IClassDispatchAttemptRepository.ts` (NUEVO).
  - Interfaz con:
    - `record(input: RecordDispatchAttemptInput): Promise<IClassDispatchAttempt>`
      (nombre `record` por consistencia con `AuditEventRepository`).
    - `listByTask(taskId: string): Promise<IClassDispatchAttempt[]>`.
  - Nota: el spec nombra `save`; el design fija `record`. Usar `record` (es el design
    quien establece el nombre de implementacion; el spec describe comportamiento).
  - MUST NOT importar nada de `@infrastructure/*`.
  - Traza: REQ-AUDIT-2, REQ-AUDIT-6.

- [x] **T-07** [GREEN] Implementar `InMemoryIClassDispatchAttemptRepository`
  - Archivo: `src/infrastructure/adapters/in-memory/InMemoryIClassDispatchAttemptRepository.ts` (NUEVO).
  - Espeja `InMemoryAuditEventRepository`: array interno, `uuid()` para generar id,
    `new Date().toISOString()` para `createdAt`.
  - `record`: inserta el attempt en el array con id y createdAt generados.
  - `listByTask`: filtra por `taskId`, ordena por `createdAt` ASC (mas antiguo primero).
  - Aceptacion: tests T-04 pasan (verde).
  - Traza: REQ-AUDIT-3.

- [x] **T-08** [GREEN] Implementar `PrismaIClassDispatchAttemptRepository`
  - Archivo: `src/infrastructure/adapters/prisma/PrismaIClassDispatchAttemptRepository.ts` (NUEVO).
  - Espeja `PrismaAuditEventRepository`: recibe `PrismaClient` en el constructor,
    accede con `(this.db as any).iClassDispatchAttempt` (el `as any` por `prisma
    generate` sin DB — mismo comentario que en el AuditEvent adapter).
  - `record`: `create({ data: { ...campos, errorCode: input.errorCode ?? null, ... } })`,
    llama `mapRow` para retornar la entidad.
  - `listByTask`: `findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } })`,
    mapea cada fila con `mapRow`.
  - `mapRow` convierte `createdAt: Date` a `createdAt: string` con `.toISOString()`.
  - Aceptacion: `tsc --noEmit` pasa con 0 errores.
  - Traza: REQ-AUDIT-3.

- [x] **T-09** Gate de calidad del commit 2
  - Tests T-04 en verde; ningun test previo roto.
  - `tsc --noEmit` 0 errores.
  - `rg 'from.*@infrastructure' src/domain/` retorna 0 matches (DIP intacto).
  - Traza: REQ-AUDIT-6.

---

## Commit 3 -- feat(iclass): nodeCode override en port + adapter IClassClient (TDD)

### Tests en ROJO primero

- [x] **T-10** [RED] Ampliar / crear tests de contrato del `IClassClient` para el override
  - Archivo: `src/__tests__/infrastructure/IClassClient.*.test.ts` o el archivo de
    tests del IClassClient que ya exista (ampliar).
  - Scenario: `buildServiceOrderPayload` (o el metodo equivalente que construye el
    payload) con `input.nodeCode = "Lujan"` y `input.city = "Mercedes"` -> el campo
    `address.nodeCode` del payload MUST ser `"Lujan"` (el override).
  - Scenario: `buildServiceOrderPayload` con `input.city = "Mercedes"` y SIN
    `input.nodeCode` -> `address.nodeCode` MUST ser `"Mercedes"` (comportamiento
    previo intacto; este scenario es el regression test del default).
  - Correr el test: debe FALLAR en el scenario de override (rojo -- el campo aun no
    existe en `CreateServiceOrderInput`).
  - Traza: REQ-RESEND-3.

### Codigo que pone en VERDE

- [x] **T-11** [GREEN] Agregar `nodeCode?: string` a `CreateServiceOrderInput` en `IClassPort.ts`
  - Archivo: `src/domain/ports/IClassPort.ts`.
  - Agregar al final de `CreateServiceOrderInput`:
    ```ts
    /**
     * Override del nodeCode (microarea). Cuando viene, el adapter usa este valor
     * como address.nodeCode en vez de derivarlo de `city` (default).
     * Aditivo y backward-compatible.
     */
    nodeCode?: string;
    ```
  - El campo es OPCIONAL. Ningun caller existente necesita cambios.
  - Aceptacion: `tsc --noEmit` pasa (no hay errores de tipo en callers existentes).
  - Traza: REQ-RESEND-3.

- [x] **T-12** [GREEN] Aplicar `input.nodeCode ?? input.city` en `IClassClient.ts`
  - Archivo: `src/infrastructure/adapters/iclass/IClassClient.ts`.
  - Localizar la linea donde se asigna `nodeCode: input.city` en
    `buildServiceOrderPayload` (o la funcion equivalente, aprox. linea 301).
  - Cambiar a: `nodeCode: input.nodeCode ?? input.city`.
  - Sin override: identico al comportamiento de hoy. Con override: el nodeCode
    elegido viaja al payload de IClass.
  - Aceptacion: tests T-10 pasan (verde); el test de regression (sin override) sigue verde.
  - Traza: REQ-RESEND-3.

- [x] **T-13** Gate de calidad del commit 3
  - Tests T-10 en verde (ambos scenarios: con y sin override).
  - `tsc --noEmit` 0 errores.
  - Ningun test previo roto (el cambio es aditivo y backward-compatible).
  - Traza: REQ-RESEND-3.

---

## Commit 4 -- feat(iclass): helper dispatchTaskToIClass + ResendTaskToIClassWithNode + audit en SendTaskToIClass (TDD)

> Este es el commit central. Cierra con suite COMPLETA (no solo los nuevos tests).

### Tests en ROJO primero

- [x] **T-14** [RED] Crear tests de `ResendTaskToIClassWithNode`
  - Archivo: `src/__tests__/application/ResendTaskToIClassWithNode.test.ts` (NUEVO).
  - Setup: `InMemorySchedulingRepository` con una tarea en stage `send_to_iclass`,
    `InMemoryIClassClient` (stub con `listNodes` y `createServiceOrder`),
    `InMemoryIClassDispatchAttemptRepository`.
  - Scenario EXITO: reenvio con `nodeCode` valido -> la tarea avanza al stage
    `registered_in_iclass`, tiene `iclassOrderCode` asignado, y se persiste un
    `IClassDispatchAttempt` con `outcome: "success"`, `attemptedNodeCode = nodeCode`,
    `resolvedNodeCode = nodeCode`, `actorId` correcto.
  - Scenario NODO INVALIDO: `nodeCode` que no existe en `listNodes()` -> lanza
    `IClassNodeNotFoundError`, `createServiceOrder` MUST NOT ser llamado, y se
    persiste un attempt con `outcome: "node_not_found"`, `attemptedNodeCode = nodeCode`,
    `resolvedNodeCode: null`.
  - Scenario IDEMPOTENCIA: tarea con `iclassOrderCode` ya asignado -> retorna la tarea
    tal como esta, `createServiceOrder` MUST NOT ser llamado, NO se crea ningun attempt.
  - Scenario TASK NOT FOUND: `taskId` inexistente -> lanza `TaskNotFoundError`.
  - Scenario ICLASS REJECTED: `createServiceOrder` lanza `IClassRejectedError` ->
    se persiste attempt `outcome: "rejected"` con `errorCode: "ICLASS_REJECTED"` y se
    re-lanza el error.
  - Scenario ICLASS UNAVAILABLE: `createServiceOrder` lanza `IClassUnavailableError` ->
    se persiste attempt `outcome: "unavailable"` con `errorCode: "ICLASS_UNAVAILABLE"` y
    se re-lanza.
  - Correr el test: debe FALLAR (rojo -- el use case no existe).
  - Traza: REQ-RESEND-1..8, REQ-AUDIT-5.

- [x] **T-15** [RED] Ampliar `SendTaskToIClass.test.ts` para el audit de fallos
  - Archivo: `src/__tests__/application/SendTaskToIClass.test.ts` (AMPLIAR).
  - Nuevo scenario FALLO POR NODO: construir `SendTaskToIClass` con el 4to arg
    `InMemoryIClassDispatchAttemptRepository`; verificar que al fallar por
    `IClassNodeNotFoundError` se persiste un attempt con `outcome: "node_not_found"`,
    `attemptedNodeCode: null`, `errorCode: "ICLASS_NODE_NOT_FOUND"`, `actorId` del actor.
  - Nuevo scenario FALLO POR REJECTED: `createServiceOrder` lanza `IClassRejectedError`
    -> se persiste attempt `outcome: "rejected"` con `attemptedNodeCode` igual al nodo
    resuelto (no null).
  - Nuevo scenario FALLO POR UNAVAILABLE: `createServiceOrder` lanza
    `IClassUnavailableError` -> se persiste attempt `outcome: "unavailable"`.
  - Nuevo scenario EXITO SIN ATTEMPT: reenvio exitoso -> `listByTask(taskId)` retorna
    array vacio (el exito del envio normal NO se registra -- REQ-AUDIT-4).
  - Nuevo scenario AUDIT NO FATAL: construir `SendTaskToIClass` con un repo cuyo
    `record` lanza `new Error("db down")` -> el envio igual falla con
    `IClassNodeNotFoundError` (el error de audit NO lo tapa ni lo reemplaza).
  - Tests EXISTENTES con 3 args siguen verdes (4to parametro OPCIONAL).
  - Correr el test: los nuevos scenarios deben FALLAR (rojo).
  - Traza: REQ-AUDIT-4.

### Codigo que pone en VERDE

- [x] **T-16** [GREEN] Crear helper `dispatchTaskToIClass`
  - Archivo: `src/application/use-cases/dispatchTaskToIClass.ts` (NUEVO).
  - Exportar interfaz `DispatchDeps` con `tasks: SchedulingRepository`,
    `iclass: IClassPort`, `attempts?: IClassDispatchAttemptRepository` (opcional).
  - Exportar interfaz `DispatchOpts` con `nodeCodeOverride?: string`,
    `actorId?: string | null`, `workflowId?: string`.
  - Exportar funcion `dispatchTaskToIClass(deps, task, soTypeCode, opts)`:
    - Resolver/validar el nodo (override o city).
    - Llamar `createServiceOrder({ ...campos, nodeCode })`.
    - En exito: `setIClassOrderCode`, mover a `registered_in_iclass`.
    - En fallo: `recordAttempt` del outcome y re-lanzar.
  - Exportar helper no-fatal `recordAttempt(attempts, input)` con `try/catch` +
    `console.error` (AD-6 — el audit NUNCA tumba el flujo).
  - Mapeo error -> outcome:
    `IClassNodeNotFoundError` -> `node_not_found`;
    `IClassRejectedError` -> `rejected`;
    `IClassUnavailableError` -> `unavailable`;
    otro -> `error`.
  - MUST NOT importar nada de `@infrastructure/*`.
  - Aceptacion: `tsc --noEmit` pasa.
  - Traza: REQ-RESEND-8, REQ-AUDIT-5, REQ-AUDIT-6.

- [x] **T-17** [GREEN] Crear use case `ResendTaskToIClassWithNode`
  - Archivo: `src/application/use-cases/ResendTaskToIClassWithNode.ts` (NUEVO).
  - Constructor: `tasks: SchedulingRepository`, `featureFlags: FeatureFlagRepository`,
    `iclass: IClassPort`, `attempts: IClassDispatchAttemptRepository` (REQUERIDO).
  - `execute(taskId: string, nodeCode: string, actorId: string | null)`:
    1. Cargar task -> `TaskNotFoundError` si no existe.
    2. Guard flag iclass ON (mismo criterio que `SendTaskToIClass`).
    3. Idempotencia: si `task.iclassOrderCode != null` -> retornar task DTO sin
       crear attempt ni OS.
    4. Validar mapping + required fields (via `dispatchTaskToIClass` o helper
       compartido del paso T-16).
    5. Validar `nodeCode` contra `listNodes()` (exacto contra `IClassNode.code`).
       Si no existe -> `recordAttempt(node_not_found)` + lanzar `IClassNodeNotFoundError`.
    6. Llamar `dispatchTaskToIClass(deps, task, soTypeCode, { nodeCodeOverride: nodeCode, actorId })`.
       En exito: attempt `success`. En fallo: attempt del outcome + re-lanzar.
  - Nota workflowId: resolver desde `task.stageId` -> `stageRepo.getById` ->
    `stage.workflowId`. Detalle de implementacion.
  - MUST NOT importar nada de `@infrastructure/*`.
  - Aceptacion: tests T-14 pasan (verde).
  - Traza: REQ-RESEND-1..8, REQ-AUDIT-5, REQ-AUDIT-6.

- [x] **T-18** [GREEN] Modificar `SendTaskToIClass` para audit de fallos (4to arg OPCIONAL)
  - Archivo: `src/application/use-cases/SendTaskToIClass.ts`.
  - Agregar 4to parametro OPCIONAL al constructor:
    `private readonly attempts?: IClassDispatchAttemptRepository`.
  - En la resolucion del nodo (paso que puede lanzar `IClassNodeNotFoundError`):
    envolver con `recordAttempt(this.attempts, { outcome: 'node_not_found',
    attemptedNodeCode: null, errorCode: 'ICLASS_NODE_NOT_FOUND',
    errorMessage: err.message, actorId, taskId })` ANTES de re-lanzar.
  - Si `createServiceOrder` lanza `IClassRejectedError`:
    `recordAttempt(... outcome: 'rejected', attemptedNodeCode: node.code, actorId ...)`.
  - Si `createServiceOrder` lanza `IClassUnavailableError`:
    `recordAttempt(... outcome: 'unavailable', attemptedNodeCode: node.code, actorId ...)`.
  - En EXITO: NO llamar `recordAttempt` (el exito normal NO se audita -- AD-7).
  - El flujo flag-OFF e idempotente NO registran attempt (no hubo intento de dispatch).
  - Tests existentes con 3 args siguen verdes (4to parametro OPCIONAL, sin valor
    `recordAttempt` hace nada si `attempts` es `undefined`).
  - Aceptacion: tests T-15 pasan (verde); tests existentes siguen verdes.
  - Traza: REQ-AUDIT-4.

- [x] **T-19** Gate de calidad del commit 4
  - Tests T-14 y T-15 en verde.
  - `tsc --noEmit` 0 errores.
  - Suite COMPLETA `npm test`: cero fallos; ninguna regresion en tests no relacionados.
  - `rg 'from.*@infrastructure' src/application/` retorna 0 matches relevantes (DIP intacto).
  - Traza: REQ-AUDIT-6, REQ-RESEND-10.

---

## Commit 5 -- feat(iclass): HTTP GET nodes + POST resend + ListIClassNodes + wiring (TDD)

### Tests en ROJO primero

- [x] **T-20** [RED] Crear tests de integracion `iclassResend.routes.test.ts`
  - Archivo: `src/__tests__/infrastructure/iclassResend.routes.test.ts` (NUEVO).
  - Setup: supertest sobre la app Express con `InMemorySchedulingRepository`,
    `InMemoryIClassClient` (stub), `InMemoryIClassDispatchAttemptRepository`,
    `FakeAuthProvider`, `InMemoryRbacRepository` (o helper de permisos ya usado
    en otros tests del repo).
  - Scenarios para `GET /api/scheduling/iclass/nodes`:
    - Sin token -> 401.
    - Con token valido sin permiso `scheduling.iclass_manual_resend` -> 403.
    - Con permiso -> 200 `{ nodes: [...] }` (array de `{ code, description }`).
    - Con `listNodes()` retornando array vacio -> 200 `{ nodes: [] }`.
  - Scenarios para `POST /api/scheduling/:id/iclass/resend`:
    - Sin token -> 401.
    - Con token sin permiso -> 403.
    - Body sin `nodeCode` o `nodeCode: ""` -> 400.
    - `taskId` inexistente -> 404.
    - `nodeCode` invalido (no en `listNodes()`) -> 422 `ICLASS_NODE_NOT_FOUND`.
    - Happy path: task en `send_to_iclass`, `nodeCode` valido -> 200, tarea con
      `iclassOrderCode` asignado y en `registered_in_iclass`.
  - Correr el test: debe FALLAR (rojo -- las rutas aun no existen).
  - Traza: REQ-NODES-1..4, REQ-RESEND-1, REQ-RESEND-7, REQ-RESEND-9, REQ-RBAC-RESEND-4.

### Codigo que pone en VERDE

- [x] **T-21** [GREEN] Crear use case `ListIClassNodes`
  - Archivo: `src/application/use-cases/ListIClassNodes.ts` (NUEVO).
  - Constructor: `private readonly iclass: IClassPort`.
  - `execute(): Promise<{ nodes: Array<{ code: string; description: string }> }>`:
    llama `this.iclass.listNodes()` y mapea cada `IClassNode` a `{ code, description }`.
    El mapeo ocurre en el use case, NO en la ruta.
  - MUST NOT importar nada de `@infrastructure/*`.
  - Aceptacion: `tsc --noEmit` pasa.
  - Traza: REQ-NODES-1, REQ-NODES-5.

- [x] **T-22** [GREEN] Agregar rutas en `scheduling.routes.ts` (ANTES del catch-all `/:id`)
  - Archivo: `src/infrastructure/http/routes/scheduling.routes.ts`.
  - Extender la firma de `createSchedulingRouter` con deps opcionales al final:
    ```ts
    resendDeps?: {
      listIClassNodes: ListIClassNodes;
      resendTaskToIClassWithNode: ResendTaskToIClassWithNode;
      requirePerm: (m: RbacModuleCode, a: PermissionAction) => RequestHandler;
    }
    ```
  - Agregar bloque `if (resendDeps)` con ambas rutas, ANTES del `router.get('/:id', ...)`:
    - `router.get('/iclass/nodes', auth, resendPerm, handler)` -> llama
      `listIClassNodes.execute()` y retorna `{ nodes }`.
    - `router.post('/:id/iclass/resend', auth, resendPerm, handler)` -> valida body
      con zod (`z.object({ nodeCode: z.string().min(1) })`), llama
      `resendTaskToIClassWithNode.execute(id, nodeCode, req.user?.id ?? null)`.
      Maneja `TaskNotFoundError` -> 404; el resto burbujea al errorHandler.
  - CRITICO: las dos rutas DEBEN registrarse ANTES de `router.get('/:id', ...)` y
    ANTES de `router.post('/:id', ...)` catch-all (gotcha conocido del router).
    Seguir el mismo patron que `checklist`, `bulkMoveTasksToStage`, `inventory-review`.
  - Aceptacion: `tsc --noEmit` pasa.
  - Traza: REQ-NODES-1, REQ-NODES-3, REQ-NODES-4, REQ-RESEND-1, REQ-RESEND-9, REQ-RBAC-RESEND-4.

- [x] **T-23** [GREEN] Wiring en `app.ts`
  - Archivo: `src/infrastructure/http/app.ts`.
  - Crear `PrismaIClassDispatchAttemptRepository` junto a los otros repos (aprox.
    linea de construccion de `featureFlagRepo`).
  - Inyectar el repo como 4to arg OPCIONAL de `SendTaskToIClass`:
    `new SendTaskToIClass(schedulingRepo, featureFlagRepo, buildIClassClient(), iclassDispatchAttemptRepo)`.
  - Crear use cases:
    `new ListIClassNodes(buildIClassClient())`.
    `new ResendTaskToIClassWithNode(schedulingRepo, featureFlagRepo, buildIClassClient(), iclassDispatchAttemptRepo)`.
  - Pasar `resendDeps` al montaje del router:
    `createSchedulingRouter(...depsExistentes, { listIClassNodes, resendTaskToIClassWithNode, requirePerm })`.
  - `requirePerm` ya existe en el scope de `app.ts` (el mismo factory usado en otros
    routers como `createGestionRealSyncRouter`).
  - Aceptacion: `tsc --noEmit` pasa; el server levanta sin errores con `npm run dev`.
  - Traza: REQ-NODES-1, REQ-RESEND-1.

- [x] **T-24** Gate de calidad del commit 5
  - Tests T-20 en verde.
  - `tsc --noEmit` 0 errores.
  - Suite COMPLETA `npm test`: cero fallos; ninguna regresion.
  - Verificar manualmente que `GET /iclass/nodes` no es resuelto por el handler de
    `/:id` (test T-20 scenario de orden de rutas lo cubre).
  - Traza: REQ-NODES-1, REQ-NODES-2, REQ-RESEND-1.

---

## Commit 6 -- feat(rbac): action scheduling.iclass_manual_resend (catalogo + migration + seed)

> No hay test Jest automatizado para la migration SQL. El gate es: migration
> idempotente, `KNOWN_ACTIONS` compila y `tsc --noEmit` 0 errores.

### Tests en ROJO primero

- [x] **T-25** [RED] Verificar / crear test de `KNOWN_ACTIONS` incluye la nueva action
  - Archivo: `src/__tests__/domain/rbac.test.ts` (ampliar si existe; crear si no).
  - Scenario: `KNOWN_ACTIONS` (o la union inferida de acciones del modulo `scheduling`)
    incluye `'iclass_manual_resend'`.
  - Scenario: `requirePerm('scheduling', 'iclass_manual_resend')` compila sin errores
    de tipo (este scenario es de compilacion; si el test usa `expectType`, usarlo;
    si no, al menos un test que construya el guard).
  - Correr el test: debe FALLAR si el test ya existe y la action no esta (rojo).
    Si el archivo no existe, crearlo con el test en rojo.
  - Traza: REQ-RBAC-RESEND-1.

### Codigo que pone en VERDE

- [x] **T-26** [GREEN] Agregar `'iclass_manual_resend'` a `KNOWN_ACTIONS` en `rbac.ts`
  - Archivo: `src/domain/entities/rbac.ts`.
  - Agregar `'iclass_manual_resend'` al array de actions del modulo `scheduling`,
    despues de `'manage_checklist'` (o al final de la seccion de scheduling sub-actions).
  - Actualizar el comentario de conteo si existe (ej. `4 base + 26 sub-actions = 30`
    -> `... = 31`).
  - Sin enum DB que tocar (VARCHAR(64) desde `20260529200000`).
  - Aceptacion: tests T-25 pasan (verde); `tsc --noEmit` pasa; `requirePerm('scheduling',
    'iclass_manual_resend')` compila sin error de tipo.
  - Traza: REQ-RBAC-RESEND-1.

- [x] **T-27** Crear migration `20260604010000_rbac_iclass_manual_resend`
  - Crear directorio `prisma/migrations/20260604010000_rbac_iclass_manual_resend/`.
  - Escribir `migration.sql` idempotente (mismo patron que pasos 5-6 de `20260529200000`):
    ```sql
    BEGIN;

    -- Seed permission scheduling.iclass_manual_resend (idempotente).
    INSERT INTO "RbacPermission" ("id", "moduleId", "action")
    SELECT gen_random_uuid(), m."id", 'iclass_manual_resend'
    FROM "RbacModule" m
    WHERE m."code" = 'scheduling'
    ON CONFLICT ("moduleId", "action") DO NOTHING;

    -- Grant a super_admin (CROSS JOIN acotado, idempotente).
    INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
    SELECT r."id", p."id", NOW()
    FROM "RbacRole" r
    CROSS JOIN "RbacPermission" p
    JOIN "RbacModule" m ON m."id" = p."moduleId"
    WHERE r."code" = 'super_admin'
      AND m."code" = 'scheduling'
      AND p."action" = 'iclass_manual_resend'
    ON CONFLICT ("roleId", "permissionId") DO NOTHING;

    COMMIT;
    ```
  - Timestamp `20260604010000` (posterior al `20260604000000_iclass_dispatch_attempt`).
  - MUST NOT depender de IDs hardcodeados (usar SELECT contra nombre/code).
  - Aceptacion: SQL contiene los dos INSERT idempotentes en una transaccion.
  - Traza: REQ-RBAC-RESEND-2, REQ-RBAC-RESEND-3.

- [x] **T-28** Actualizar `prisma/seed.ts` (opcional pero recomendado)
  - Archivo: `prisma/seed.ts`.
  - Agregar `'iclass_manual_resend'` al array de actions de scheduling en el bloque
    de seed de permisos (el bloque T-29 existente, aprox. lineas 356-389) para que
    entornos limpios (sin migrations previas) tengan el permiso sembrado.
  - El grant a `super_admin` ya lo cubre el CROSS JOIN de la migration.
  - Aceptacion: `npm run prisma:seed` corre sin errores; re-correr es idempotente.
  - Traza: REQ-RBAC-RESEND-5.

- [x] **T-29** Gate de calidad final del commit 6 (cierre del change)
  - Tests T-25 en verde; ningun test previo roto.
  - `tsc --noEmit` 0 errores.
  - Suite COMPLETA `npm test`: cero fallos; sin regresiones.
  - Verificar DIP: `rg 'from.*@infrastructure' src/application/` retorna 0 matches
    relevantes (ningun use case importa infra).
  - Verificar DIP: `rg 'from.*@prisma' src/application/` retorna 0 matches.
  - Revisar Success Criteria de `proposal.md` y marcar los cumplidos.
  - Traza: REQ-RBAC-RESEND-1..5, REQ-AUDIT-6, REQ-RESEND-10.

---

## Resumen de trazabilidad REQ -> Tasks

| Requisito              | Tasks                              |
| ---------------------- | ---------------------------------- |
| REQ-AUDIT-1            | T-01, T-02, T-03                   |
| REQ-AUDIT-2            | T-04, T-05, T-06                   |
| REQ-AUDIT-3            | T-07, T-08                         |
| REQ-AUDIT-4            | T-15, T-18                         |
| REQ-AUDIT-5            | T-14, T-17                         |
| REQ-AUDIT-6            | T-06, T-09, T-16, T-17, T-19, T-29 |
| REQ-NODES-1            | T-21, T-22, T-23, T-24             |
| REQ-NODES-2            | T-20, T-24                         |
| REQ-NODES-3            | T-20, T-22                         |
| REQ-NODES-4            | T-20, T-22                         |
| REQ-NODES-5            | T-21                               |
| REQ-RESEND-1           | T-22, T-23                         |
| REQ-RESEND-2           | T-14, T-17                         |
| REQ-RESEND-3           | T-10, T-11, T-12, T-13             |
| REQ-RESEND-4           | T-14, T-17                         |
| REQ-RESEND-5           | T-14, T-17                         |
| REQ-RESEND-6           | T-14, T-17                         |
| REQ-RESEND-7           | T-14, T-20, T-22                   |
| REQ-RESEND-8           | T-14, T-16, T-17                   |
| REQ-RESEND-9           | T-20, T-22                         |
| REQ-RESEND-10          | T-17, T-19                         |
| REQ-RBAC-RESEND-1      | T-25, T-26                         |
| REQ-RBAC-RESEND-2      | T-27                               |
| REQ-RBAC-RESEND-3      | T-27                               |
| REQ-RBAC-RESEND-4      | T-20, T-22                         |
| REQ-RBAC-RESEND-5      | T-27, T-28                         |
