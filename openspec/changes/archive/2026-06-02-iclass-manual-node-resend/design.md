# Design: iclass-manual-node-resend

## Technical Approach

El envio normal (`SendTaskToIClass`) resuelve el nodo IClass matcheando
`task.customerCity` contra `IClassPort.listNodes()` (norm: trim+lower+sin acentos).
Si no matchea, lanza `IClassNodeNotFoundError` -> 422 y la tarea NO avanza, SIN
trazabilidad. Este change agrega: (1) un modelo auditable minimo
`IClassDispatchAttempt` (FK a `ScheduledTask`, onDelete Cascade) que registra cada
intento de envio a IClass (exito/fallo) con actor, nodo y error; (2) un camino de
recuperacion SINCRONO y explicito `POST /api/scheduling/:id/iclass/resend` que
override el `nodeCode` (NO otros campos de la OS); (3) un GET dedicado de nodos
para alimentar el dropdown del FE; (4) un permiso granular nuevo
`scheduling.iclass_manual_resend`.

Pilares de diseno:
- **DIP estricto**: el use case depende de ports (`SchedulingRepository`,
  `FeatureFlagRepository`, `IClassPort`, `IClassDispatchAttemptRepository`); NUNCA
  de Prisma ni de Express. El recorder de audit es un port mas.
- **Reuso sin duplicar**: el reenvio NO reimplementa la logica de envio. Se extrae
  un helper compartido `dispatchTaskToIClass` (funcion pura de orquestacion sobre
  ports) que `SendTaskToIClass` y `ResendTaskToIClassWithNode` invocan, pasando
  `nodeCode` override opcional. Ver AD-3.
- **Audit no-fatal (best-effort)**: registrar el attempt NUNCA debe tumbar el
  envio/reenvio. Wrap en `try/catch` con `console.error`, igual filosofia que el
  recorder de `auditMutationsMiddleware`. Ver AD-6.
- **Override aditivo y backward-compatible**: `CreateServiceOrderInput.nodeCode?`
  opcional; el adapter usa `input.nodeCode ?? input.city`. El default (nodo=city)
  no cambia. Ver AD-4.
- **Migrations aditivas**, SQL sin DB, `migrate deploy` en prod, timestamp
  posterior a `20260603000000_stage_code`. RBAC sin `ALTER TYPE` (action es
  VARCHAR(64) desde `20260529200000`).

6 commits atomicos, cada uno verde (TDD red->green) antes de avanzar.

## Architecture Decisions

| # | Decision | Elegido | Alternativa rechazada | Razon |
|---|----------|---------|----------------------|-------|
| 1 | Forma del modelo de audit | Campos tipados minimos (NO payload crudo de IClass) | `Json` con snapshot completo de la OS | Evita filtrar datos sensibles / peso; los campos cubren el caso (que nodo, que error, quien). Confirmado en proposal Open Q2 |
| 2 | `outcome` como string vs enum Postgres | `String` (whitelist en codigo TS, sin enum DB) | enum Postgres `IClassDispatchOutcome` | Mismo criterio que `RbacPermission.action` migrado a VARCHAR (`20260529200000`): agregar outcomes futuros no requiere `ALTER TYPE`. Whitelist `success\|node_not_found\|rejected\|unavailable\|error` vive en la entity de dominio |
| 3 | Reuso entre envio y reenvio | Extraer helper `dispatchTaskToIClass(deps, task, mapping, opts)` en application, invocado por ambos use cases | Que el resend llame al move-stage con body especial; o duplicar la logica | El move-stage se dispara por MOVER stage (no intencional/auditable); duplicar viola DRY. Helper puro sobre ports preserva DIP. Confirmado Open Q3 (accion explicita) |
| 4 | Override de nodeCode | `nodeCode?: string` en `CreateServiceOrderInput`; adapter `input.nodeCode ?? input.city` | nuevo metodo `createServiceOrderWithNode` en el port | Aditivo, un solo punto de mapeo, default identico. Cambio minimo de superficie del port |
| 5 | Como obtiene el FE los nodos | GET dedicado `/api/scheduling/iclass/nodes` (NO meter `availableNodes` en el body del 422) | Inflar el body del `IClassNodeNotFoundError` con la lista | Separa responsabilidades; recurso reusable y cacheable; no engorda TODOS los 422 (incluido el de envio masivo). Confirmado Open Q1 (b) |
| 6 | Audit como dependencia opcional o requerida | Inyectado por constructor; en `SendTaskToIClass` OPCIONAL (`?`) para no romper los tests existentes que construyen el use case sin el repo | Requerido en ambos | `SendTaskToIClass` ya tiene constructor con 3 deps y tests que lo arman; hacerlo opcional + best-effort minimiza el blast radius. `ResendTaskToIClassWithNode` lo recibe REQUERIDO (es razon de ser del change) |
| 7 | Registrar attempt en envio normal | SI — registrar SOLO los FALLOS en `SendTaskToIClass` (NodeNotFound, Rejected, Unavailable); el EXITO del envio normal NO se registra | Registrar exito Y fallo (o no registrar nada) | El historial arranca desde el fallo original para que el reenvio quede como resolucion del mismo hilo. El exito normal NO se audita: si la OS se creo bien la primera vez no hay nada que recuperar ni historial relevante. Confirmado Open Q4 + decision del usuario (solo fallos en normal; todo en reenvio manual) |
| 8 | Trigger del reenvio | Accion explicita `POST /:id/iclass/resend` | Re-disparar por re-mover el stage | El override de nodo es intencional y auditable; la tarea ya quedo en `send_to_iclass`. Confirmado Open Q3 |
| 9 | Modulo de la action RBAC | `scheduling.iclass_manual_resend` | `iclass.manual_resend` | El reenvio opera una TAREA (modulo scheduling); `iclass` agrupa sync/catalogo. Confirmado proposal Open Q5 + orquestador (4) |
| 10 | Validacion de `nodeCode` en el reenvio | Contra `listNodes()` (debe EXISTIR el code, exacto o por norm); si no, `IClassNodeNotFoundError` | Confiar ciegamente en el FE | El FE puede mandar un code stale; validar evita crear OS con nodo invalido |
| 11 | Idempotencia | Si `task.iclassOrderCode != null` -> NO recrea OS, solo avanza a `registered_in_iclass` y registra attempt `success` (mismo check que `SendTaskToIClass`) | Recrear siempre | Evita OS duplicada. El caso real de uso es que la OS NO se creo (fallo antes del `createServiceOrder`) |

## Schema & Migration

### schema.prisma (extracto NUEVO)

```prisma
model IClassDispatchAttempt {
  id     String        @id @default(uuid())
  taskId String
  task   ScheduledTask @relation(fields: [taskId], references: [id], onDelete: Cascade)

  /// success | node_not_found | rejected | unavailable | error
  outcome           String
  /// Domain error code (ICLASS_NODE_NOT_FOUND, ICLASS_REJECTED, ...) when outcome != success.
  errorCode         String?
  /// Human-readable error detail (e.g. IClass `erros` concatenation). Truncado en el caller si hace falta.
  errorMessage      String?
  /// Node code que se INTENTO. En el fallo automatico por city = la city normalizada; null si no aplica.
  attemptedNodeCode String?
  /// Node code que efectivamente RESOLVIO/uso (el elegido en el reenvio, o el matcheado por city en exito).
  resolvedNodeCode  String?
  /// Actor que disparo el intento. Null para automaticos sin usuario; FK suelta a RbacUser (sin relacion para no atar el modelo).
  actorId           String?
  createdAt         DateTime @default(now())

  @@index([taskId, createdAt])
}
```

Y en `model ScheduledTask`, agregar la back-relation (junto a las otras
back-relations NEW):

```prisma
  // IClass dispatch audit — intentos de envio a IClass (exito/fallo)
  iclassDispatchAttempts IClassDispatchAttempt[]
```

Notas:
- `actorId` queda como `String?` SIN `@relation` a `RbacUser` a proposito: el
  audit no debe romperse si el usuario se borra, y mantener el modelo sin FK dura
  a RbacUser evita cascadas/SetNull innecesarias. Es un puntero suelto (mismo
  espiritu que `AuditEvent.actorId`, que es nullable y desacoplado).
- `outcome` String (AD-2): la whitelist vive en la entity de dominio
  (`ICLASS_DISPATCH_OUTCOMES`), no en la DB.
- Indice `@@index([taskId, createdAt])` cubre el `listByTask` ordenado por fecha.

### Migration: `prisma/migrations/20260604000000_iclass_dispatch_attempt/migration.sql`

Timestamp `20260604000000` (posterior al ultimo, `20260603000000_stage_code`).
SQL generado sin DB (a mano, aditivo puro: CREATE TABLE + FK + index). En prod
`npx prisma migrate deploy` (NUNCA `migrate dev`).

```sql
-- CreateTable: IClassDispatchAttempt (audit minimo de intentos de envio a IClass)
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

-- Index para listByTask ordenado por fecha
CREATE INDEX "IClassDispatchAttempt_taskId_createdAt_idx"
    ON "IClassDispatchAttempt"("taskId", "createdAt");

-- FK a ScheduledTask con borrado en cascada (si se borra la task, se borran sus intentos)
ALTER TABLE "IClassDispatchAttempt"
    ADD CONSTRAINT "IClassDispatchAttempt_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
```

Aditiva: NO toca tablas existentes. Rollback = `prisma migrate resolve
--rolled-back 20260604000000_iclass_dispatch_attempt` + `DROP TABLE` si fuese
imprescindible. Dejar la tabla no rompe codigo viejo.

## Domain: entity + port

### `src/domain/entities/iclass-dispatch-attempt.ts` (NUEVO)

```ts
/** Whitelist de outcomes (AD-2). La DB guarda `outcome` como String (sin enum). */
export const ICLASS_DISPATCH_OUTCOMES = [
  'success',
  'node_not_found',
  'rejected',
  'unavailable',
  'error',
] as const;

export type IClassDispatchOutcome = (typeof ICLASS_DISPATCH_OUTCOMES)[number];

/** Un intento de envio de una tarea a IClass (exito o fallo). Entidad de dominio. */
export interface IClassDispatchAttempt {
  id: string;
  taskId: string;
  outcome: IClassDispatchOutcome;
  errorCode: string | null;
  errorMessage: string | null;
  attemptedNodeCode: string | null;
  resolvedNodeCode: string | null;
  actorId: string | null;
  createdAt: string; // ISO
}

/** Input para registrar un intento (sin id/createdAt — los pone el adapter). */
export interface RecordDispatchAttemptInput {
  taskId: string;
  outcome: IClassDispatchOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
  attemptedNodeCode?: string | null;
  resolvedNodeCode?: string | null;
  actorId?: string | null;
}
```

### `src/domain/ports/IClassDispatchAttemptRepository.ts` (NUEVO)

```ts
import type {
  IClassDispatchAttempt,
  RecordDispatchAttemptInput,
} from '@domain/entities/iclass-dispatch-attempt';

export interface IClassDispatchAttemptRepository {
  /** Registra un intento. Best-effort: el caller envuelve en try/catch (AD-6). */
  record(input: RecordDispatchAttemptInput): Promise<IClassDispatchAttempt>;
  /** Historial de intentos de una tarea, mas reciente primero. */
  listByTask(taskId: string): Promise<IClassDispatchAttempt[]>;
}
```

Nota: el proposal menciona `save`/`listByTask`; se nombra `record` por
consistencia con `AuditEventRepository.record` (mismo dominio de audit), pero la
firma es la del proposal. Cualquiera de los dos nombres es aceptable; el design
fija `record`.

### Adapters

`src/infrastructure/adapters/in-memory/InMemoryIClassDispatchAttemptRepository.ts`
(tests primero) — espeja `InMemoryAuditEventRepository`: array interno, `__seq`
para tie-break, `listByTask` filtra por `taskId` y ordena `createdAt` DESC.

`src/infrastructure/adapters/prisma/PrismaIClassDispatchAttemptRepository.ts` —
espeja `PrismaAuditEventRepository`: `(this.db as any).iClassDispatchAttempt`
(el `as any` por `prisma generate` sin DB, mismo comentario que en el AuditEvent
adapter), `create` con `?? undefined` para que las columnas opcionales queden
NULL, `mapRow` que pasa `createdAt.toISOString()`.

```ts
// PrismaIClassDispatchAttemptRepository (esqueleto)
async record(input: RecordDispatchAttemptInput): Promise<IClassDispatchAttempt> {
  const row = (await (this.db as any).iClassDispatchAttempt.create({
    data: {
      taskId: input.taskId,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      attemptedNodeCode: input.attemptedNodeCode ?? null,
      resolvedNodeCode: input.resolvedNodeCode ?? null,
      actorId: input.actorId ?? null,
    },
  })) as IClassDispatchAttemptRow;
  return mapRow(row);
}
```

## Override de nodo en el port + adapter

### `src/domain/ports/IClassPort.ts` (MODIFICADO, AD-4)

Agregar a `CreateServiceOrderInput` (campo opcional, al final):

```ts
  /**
   * Override del nodeCode (microárea). Cuando viene, el adapter lo usa como
   * address.nodeCode en vez de derivarlo de `city` (default). Lo setea el reenvio
   * manual (ResendTaskToIClassWithNode). Aditivo y backward-compatible.
   */
  nodeCode?: string;
```

### `src/infrastructure/adapters/iclass/IClassClient.ts:301` (MODIFICADO)

```ts
// antes
        nodeCode: input.city,
// despues
        nodeCode: input.nodeCode ?? input.city,
```

Sin override -> identico a hoy (nodo=city). Con override -> el nodeCode viaja
distinto. El test de contrato cubre ambos caminos.

## Application: helper compartido + use cases

### Helper `dispatchTaskToIClass` (reuso — AD-3)

Para no duplicar mapping+required-fields+create+advance entre envio y reenvio, se
extrae la orquestacion a una funcion pura sobre ports. Ubicacion:
`src/application/use-cases/dispatchTaskToIClass.ts` (helper de application, NO
adapter; el code es regla de negocio). Ambos use cases lo invocan.

```ts
export interface DispatchDeps {
  tasks: SchedulingRepository;
  iclass: IClassPort;
  attempts?: IClassDispatchAttemptRepository; // opcional (best-effort)
}

export interface DispatchOpts {
  /** Override de nodo (reenvio manual). Si viene, salta la resolucion por city. */
  nodeCodeOverride?: string;
  /** Actor para el audit. */
  actorId?: string | null;
  /** Workflow del stage destino, para resolver registered_in_iclass scoped. */
  workflowId?: string;
}

/**
 * Orquesta: validar required fields + mapping (ya resueltos por el caller),
 * resolver/validar el nodo, crear la OS con nodeCode (override o city),
 * persistir orderCode, avanzar a registered_in_iclass. Registra IClassDispatchAttempt
 * (best-effort) en exito y fallo. Reusado por SendTaskToIClass y el reenvio.
 */
export async function dispatchTaskToIClass(
  deps: DispatchDeps,
  task: ScheduledTask,
  soTypeCode: string,
  opts: DispatchOpts,
): Promise<ScheduledTask> { /* ... */ }
```

Nota de alcance: si extraer el helper se vuelve invasivo para los tests
existentes de `SendTaskToIClass`, la alternativa equivalente (AD-3) es que
`ResendTaskToIClassWithNode` reciba una instancia de `SendTaskToIClass` y le
agregue un parametro `nodeCodeOverride?` opcional al `execute`. Decision de
implementacion del commit 4; el contrato observable es el mismo. El criterio
duro: NO duplicar la secuencia mapping->validate-node->create->advance.

### `recordAttempt` helper no-fatal (AD-6)

```ts
async function recordAttempt(
  attempts: IClassDispatchAttemptRepository | undefined,
  input: RecordDispatchAttemptInput,
): Promise<void> {
  if (!attempts) return;
  try {
    await attempts.record(input);
  } catch (e) {
    // best-effort: el audit NUNCA tumba el envio/reenvio
    console.error('[iclass-dispatch-audit] failed to record attempt', e);
  }
}
```

Mapeo error -> outcome:
- `IClassNodeNotFoundError` -> `node_not_found`
- `IClassRejectedError`     -> `rejected`
- `IClassUnavailableError`  -> `unavailable`
- otro `DomainError`/error  -> `error`
- exito                     -> `success`

### `SendTaskToIClass.ts` (MODIFICADO — AD-6, AD-7)

- Constructor: agregar 4to parametro OPCIONAL
  `private readonly attempts?: IClassDispatchAttemptRepository`.
- En el paso 5 (resolucion de nodo): si `IClassNodeNotFoundError` -> `recordAttempt`
  con outcome `node_not_found`, `attemptedNodeCode = null` (no se resolvio el nodo),
  `errorCode = 'ICLASS_NODE_NOT_FOUND'`, y RE-LANZA.
- En el paso 6/7 (create + advance): en EXITO -> NO registrar ninggun attempt (el
  exito del envio normal NO se audita — AD-7); si `createServiceOrder` lanza
  (rejected/unavailable) -> `recordAttempt` del outcome correspondiente con
  `attemptedNodeCode = node.code` (el nodo que se resolvio) y RE-LANZA.
- El flujo flag-OFF y el idempotente NO registran attempt (no hubo dispatch real;
  decision: registrar SOLO cuando hay intento de creacion o validacion de nodo).
- Tests existentes que construyen `SendTaskToIClass` con 3 args siguen verdes
  (4to opcional). El test nuevo pasa el in-memory y asierta el registro.

### `src/application/use-cases/ResendTaskToIClassWithNode.ts` (NUEVO)

```ts
export class ResendTaskToIClassWithNode {
  constructor(
    private readonly tasks: SchedulingRepository,
    private readonly featureFlags: FeatureFlagRepository,
    private readonly iclass: IClassPort,
    private readonly attempts: IClassDispatchAttemptRepository, // REQUERIDO (AD-6)
  ) {}

  async execute(taskId: string, nodeCode: string, actorId: string | null): Promise<ScheduledTask> {
    // 1. cargar task -> TaskNotFoundError (404)
    // 2. flag iclass ON (si OFF: decision -> 422/409 "iclass disabled" o no-op;
    //    recomendado: tratar igual que el envio normal -> si OFF no hay reenvio a IClass.
    //    Para el caso real el flag esta ON. Documentar el guard.)
    // 3. idempotencia: si task.iclassOrderCode != null -> avanzar a registered_in_iclass,
    //    registrar attempt success (resolvedNodeCode = nodeCode), NO recrear OS (AD-11).
    // 4. resolver mapping/required-fields (reusa la validacion del helper/SendTaskToIClass).
    // 5. validar nodeCode contra listNodes() (exacto o por norm). Si no existe ->
    //    recordAttempt(node_not_found, attemptedNodeCode=nodeCode) y throw IClassNodeNotFoundError.
    // 6. dispatchTaskToIClass(deps, task, soTypeCode, { nodeCodeOverride: nodeCode, actorId, workflowId }).
    //    En exito: setIClassOrderCode + moveToRegistrado + recordAttempt(success, resolved=nodeCode).
    //    En fallo (rejected/unavailable): recordAttempt + re-throw (errorHandler ya mapea).
  }
}
```

Nota workflowId: `moveToRegistrado` necesita `workflowId` (porque `getStageByCode`
lo exige, BE-1). El reenvio resuelve el workflowId del stage actual de la task
(la task ya esta en `send_to_iclass`); se obtiene via el stage de la task. Si el
caller no lo tiene a mano, el use case lo resuelve desde `task.stageId` ->
`stageRepo.getById` -> `stage.workflowId`. Detalle de implementacion del commit 4.

### `src/application/use-cases/ListIClassNodes.ts` (NUEVO)

Use case fino que envuelve `iclass.listNodes()` y mapea a DTO de salida
`{ code, description }` (NO devuelve el tipo del port crudo si difiriera; aca
coincide, pero el mapeo explicito protege el contrato FE).

```ts
export class ListIClassNodes {
  constructor(private readonly iclass: IClassPort) {}
  async execute(): Promise<Array<{ code: string; description: string }>> {
    const nodes = await this.iclass.listNodes();
    return nodes.map(n => ({ code: n.code, description: n.description }));
  }
}
```

## HTTP: GET nodos + POST reenvio + wiring

### Rutas en `scheduling.routes.ts` (MODIFICADO)

CRITICO: ambas rutas van ANTES del catch-all `router.get('/:id', ...)` (linea 269)
para que Express no las shadow-ee, igual que checklist/bulk/inventory-review.
Se montan dentro de un bloque `if (resendDeps)` (deps opcionales, mismo patron que
`checklist`/`bulkMoveTasksToStage`).

```ts
// firma extendida de createSchedulingRouter — agregar al final (opcionales):
//   resendDeps?: {
//     listIClassNodes: ListIClassNodes;
//     resendTaskToIClassWithNode: ResendTaskToIClassWithNode;
//     requirePerm: (m: RbacModuleCode, a: PermissionAction) => RequestHandler;
//   }

if (resendDeps) {
  const { listIClassNodes, resendTaskToIClassWithNode, requirePerm } = resendDeps;
  const resendPerm = requirePerm('scheduling', 'iclass_manual_resend');

  // GET /api/scheduling/iclass/nodes  (ANTES de /:id)
  router.get('/iclass/nodes', auth, resendPerm, async (_req, res, next) => {
    try {
      const nodes = await listIClassNodes.execute();
      res.status(200).json({ nodes });
    } catch (err) { next(err); } // ICLASS_UNAVAILABLE burbujea
  });

  // POST /api/scheduling/:id/iclass/resend  (ANTES de /:id)
  router.post('/:id/iclass/resend', auth, resendPerm, async (req, res, next) => {
    const Schema = z.object({ nodeCode: z.string().min(1) });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const task = await resendTaskToIClassWithNode.execute(
        req.params['id'] as string,
        parsed.data.nodeCode,
        req.user?.id ?? null,
      );
      res.status(200).json(task);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      // IClassNodeNotFoundError (422), ICLASS_REJECTED (422), ICLASS_UNAVAILABLE (502)
      // burbujean al errorHandler global (ya mapeados en statusMap).
      next(err);
    }
  });
}
```

Ubicacion exacta: insertar el bloque `if (resendDeps)` JUNTO con los otros bloques
`MUST be registered BEFORE /:id` (entre el bloque `bulkMoveTasksToStage` y el
`router.get('/:id', ...)`). El GET `/iclass/nodes` NO colisiona con `/:id` porque
`iclass` no es un id de task, pero registrarlo arriba es defensivo y consistente.

Status codes:
- GET nodos: 200 `{ nodes: [{code,description}] }`; 401 sin token; 403 sin permiso;
  502 si IClass unavailable.
- POST resend: 200 task DTO; 400 body invalido; 401; 403; 404 task no existe;
  422 nodo no encontrado / rejected; 502 unavailable.

### Wiring en `app.ts` (MODIFICADO)

Cerca de la construccion de `sendTaskToIClass` (linea 627) y del montaje del
router (linea 986):

```ts
// 1. repo de attempts (junto a featureFlagRepo)
const iclassDispatchAttemptRepo = new PrismaIClassDispatchAttemptRepository();

// 2. inyectar en SendTaskToIClass (4to arg opcional, AD-6)
const sendTaskToIClass = new SendTaskToIClass(
  schedulingRepo, featureFlagRepo, buildIClassClient(), iclassDispatchAttemptRepo,
);

// 3. use cases del reenvio
const listIClassNodes = new ListIClassNodes(buildIClassClient());
const resendTaskToIClassWithNode = new ResendTaskToIClassWithNode(
  schedulingRepo, featureFlagRepo, buildIClassClient(), iclassDispatchAttemptRepo,
);

// 4. pasar al router (nuevo arg final)
app.use('/api/scheduling', createSchedulingRouter(
  listTasks, getTask, createTask, updateTask, deleteTask, moveTaskToStage,
  authAdapter, stageRepo, { /* checklist */ }, setTaskInventoryReview,
  bulkMoveTasksToStage,
  { listIClassNodes, resendTaskToIClassWithNode, requirePerm },
));
```

`requirePerm` ya es el factory exportado/usado en app.ts (`requirePerm('scheduling',
'read')` etc., lineas 968-970). Se pasa tal cual.

## RBAC: action `iclass_manual_resend`

### `src/domain/entities/rbac.ts` (MODIFICADO)

Agregar a `KNOWN_ACTIONS`, en la seccion scheduling sub-actions (despues de
`manage_checklist`):

```ts
  // scheduling sub-actions
  'send_to_iclass',
  'bulk_delete',
  'move_stage',
  'manage_checklist',
  'iclass_manual_resend', // NUEVO
```

Actualizar el comentario de conteo (`4 base + 26 sub-actions = 30 total` ->
`... + 1 = 31`). No hay enum DB que tocar (VARCHAR(64)).

### Migration: `prisma/migrations/20260604010000_rbac_iclass_manual_resend/migration.sql`

Timestamp `20260604010000` (posterior al de la tabla). Idempotente, mismo patron
que pasos 5-6 de `20260529200000`.

```sql
BEGIN;

-- 1. Seed permission scheduling.iclass_manual_resend (idempotente).
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'iclass_manual_resend'
FROM "RbacModule" m
WHERE m."code" = 'scheduling'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 2. Grant a super_admin (idempotente, CROSS JOIN acotado a la fila nueva).
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

Nota: `super_admin` ya short-circuitea en `requirePermission`, pero la fila se
siembra igual para consistencia del catalogo (mismo criterio que el proposal).

### `prisma/seed.ts` (MODIFICADO, opcional)

Reflejar el INSERT del permission para entornos limpios (super_admin ya recibe
todo por el grant de migration). Opcional concederla tambien a `administrador` si
se decide operativamente (coordinar; NO obligatorio para el change). Se reusa el
bloque T-29 existente (lineas 356-389) agregando `'iclass_manual_resend'` al array
de actions de scheduling si se quiere dar a `administrador`. Decision operativa,
no de diseno.

## Plan TDD — 6 commits atomicos

| # | Commit | Test RED primero | Codigo que pone GREEN | Archivos de test |
|---|--------|------------------|------------------------|------------------|
| 1 | `feat(iclass): IClassDispatchAttempt schema + migration` | (gate: `migrate deploy` en copia + verificar tabla/FK/index) | schema.prisma + `20260604000000_iclass_dispatch_attempt/migration.sql` | — (verificacion manual + `tsc --noEmit`) |
| 2 | `feat(iclass): dispatch-attempt entity + port + adapters (TDD)` | test in-memory: `record` persiste; `listByTask` filtra+ordena DESC | entity `iclass-dispatch-attempt.ts`, port `IClassDispatchAttemptRepository.ts`, in-memory + Prisma adapters | `src/__tests__/infrastructure/InMemoryIClassDispatchAttemptRepository.test.ts` |
| 3 | `feat(iclass): nodeCode override en port + adapter (TDD)` | test contrato: con `nodeCode` el payload.address.nodeCode = override; sin -> = city | `IClassPort.CreateServiceOrderInput.nodeCode?`, `IClassClient.buildServiceOrderPayload` `?? city` | `src/__tests__/infrastructure/IClassClient.*.test.ts` (ampliar el de payload) |
| 4 | `feat(iclass): ResendTaskToIClassWithNode + audit en envio normal (TDD)` | test in-memory: exito (crea OS+avanza+attempt success), nodo invalido (422+attempt node_not_found, NO crea OS), idempotencia (task con orderCode no recrea); SendTaskToIClass registra SOLO fallos (NodeNotFound/Rejected/Unavailable), exito NO registra attempt | helper `dispatchTaskToIClass`, `ResendTaskToIClassWithNode`, `SendTaskToIClass` (4to arg OPCIONAL + recordAttempt no-fatal solo en fallos) | `src/__tests__/application/ResendTaskToIClassWithNode.test.ts` (nuevo) + ampliar `SendTaskToIClass.test.ts` |
| 5 | `feat(iclass): HTTP GET nodes + POST resend + ListIClassNodes + wiring (TDD)` | test supertest: GET 401/403/200; POST 401/403/400/200/404/422 | `ListIClassNodes`, rutas en `scheduling.routes.ts` (antes del catch-all), wiring `app.ts` | `src/__tests__/infrastructure/iclassResend.routes.test.ts` (nuevo) |
| 6 | `feat(rbac): action scheduling.iclass_manual_resend (catalogo + seed)` | test: `iclass_manual_resend` en `KNOWN_ACTIONS`; (gate) migration idempotente re-run | `KNOWN_ACTIONS` + `20260604010000_rbac_iclass_manual_resend/migration.sql` + seed opcional | ampliar test de rbac/known-actions si existe; gate manual de migration |

Orden justificado: schema (1) bloquea persistencia; dominio/port/adapters (2)
bloquean el use case; el override de nodo (3) es prerequisito del reenvio (4);
HTTP (5) cierra el flujo; RBAC (6) es ortogonal y va al final. Correr suite
COMPLETA al cierre del commit 4 y del 5. Cada commit pasa `tsc --noEmit` antes de
avanzar. Conventional commits, sin `Co-Authored-By`.

## Riesgos y rollback

| Riesgo | Prob | Mitigacion |
|--------|------|------------|
| El audit (record) tira y tumba el envio/reenvio | Med | `recordAttempt` envuelve en try/catch + `console.error` (AD-6, best-effort). NUNCA propaga. Test: repo que lanza en `record` -> el envio igual completa |
| Romper tests existentes de `SendTaskToIClass` al inyectar el repo | Med | 4to parametro OPCIONAL (`?`); tests viejos con 3 args siguen verdes (AD-6). Suite completa al cierre commit 4 |
| Reenvio crea OS duplicada si ya existe `iclassOrderCode` | Low | Guard de idempotencia (AD-11): si `iclassOrderCode != null` no recrea, solo avanza + attempt success |
| Override de nodeCode rompe el flujo normal | Low | `nodeCode` OPCIONAL; `input.nodeCode ?? input.city`; test de contrato cubre ambos caminos (AD-4) |
| Colision de ruta con catch-all `/:id` | Med | GET `/iclass/nodes` y POST `/:id/iclass/resend` registradas ANTES de `/:id` (gotcha documentado en el router) |
| `InMemoryIClassClient` inerte sin secrets -> `listNodes()` vacio -> dropdown vacio | Med | Mismo riesgo que el envio normal (docs/iclass-integration.md). Fuera de scope; FE muestra estado vacio |
| La action queda sin asignar -> nadie reenvia | Med | Migration concede a `super_admin` por CROSS JOIN idempotente; ademas super_admin short-circuitea en `requirePermission` |
| `outcome` con valor fuera de whitelist | Low | La whitelist `ICLASS_DISPATCH_OUTCOMES` vive en la entity; el caller siempre usa la constante. DB es String permisivo (AD-2), pero el codigo no escribe valores libres |

### Rollback

- Cada commit revertible via `git revert <sha>` independiente.
- Migration tabla: aditiva; rollback = `prisma migrate resolve --rolled-back
  20260604000000_iclass_dispatch_attempt` + `DROP TABLE` si imprescindible. Dejar
  la tabla no rompe codigo viejo.
- Migration RBAC: permission + grant aditivos e idempotentes; dejarlos no afecta
  a roles que no la tienen. `ON CONFLICT DO NOTHING` -> re-correr no duplica.
- Revertir commit 5 (HTTP) devuelve `scheduling.routes` y `app.ts` al estado
  previo sin tocar dominio/migrations.
- Revertir commit 4 deja schema+port+adapters intactos; `SendTaskToIClass` vuelve
  a NO registrar attempts (4to arg opcional desaparece).
- En prod `migrate deploy`; seeds RBAC `ON CONFLICT DO NOTHING`.

## Open Questions resueltas (cierre)

Todas las Open Questions del proposal quedan CERRADAS por las decisiones del
orquestador y este design:
- Q1 -> (b) GET dedicado de nodos (AD-5).
- Q2 -> campos tipados minimos (AD-1).
- Q3 -> accion explicita `POST /:id/iclass/resend` (AD-8).
- Q4 -> SI, registrar attempt en envio normal, exito Y fallo (AD-7).
- Q5 -> action en modulo `scheduling` (AD-9).

Pendiente operativo (NO bloquea el change): si `administrador` (u otros roles)
deben recibir `iclass_manual_resend` ademas de `super_admin` — decision de seed,
coordinar con FE/operaciones.
