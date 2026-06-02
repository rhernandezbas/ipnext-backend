# Design: scheduling-stage-code

## Technical Approach

Introducir un campo `code String` INMUTABLE en `Stage` como IDENTIDAD de negocio
estable. El `name` queda como label editable por el usuario. Toda la logica de
scheduling (integracion IClass, ingest GR, backfill) deja de resolver stages por
`name` (string literal en espanol, fragil ante renames) y pasa a resolver por
`code` (slug estable en ingles para los stages con logica, slug del name para el
resto). La migration es ADITIVA y en TRES pasos dentro de UN solo archivo
(`ADD COLUMN nullable` -> `UPDATE` backfill idempotente con `DO $$` -> `SET NOT
NULL` + indice unico), siguiendo el patron de
`20260520000000_scheduling_foundation_stage_model`. El `code` se autogenera del
`name` al crear un stage via slug deterministico con desambiguacion por sufijo
numerico dentro del workflow. Se respeta DIP estricto: el dominio agrega `code` a
la entity y al port; los adapters lo persisten/mapean; ningun use case importa de
infrastructure. 6 commits atomicos, cada uno verde (TDD red->green) antes de
avanzar.

## Architecture Decisions

| # | Decision | Elegido | Alternativa rechazada | Razon |
|---|----------|---------|----------------------|-------|
| 1 | Unicidad de `code` | `@@unique([workflowId, code])` | unique global | El mismo paso logico (`registered_in_iclass`) se repite entre workflows; la logica ya pasa `workflowId` para desambiguar homonimos |
| 2 | `getStageByName` | DEPRECAR (`@deprecated`), no borrar en este change | Borrar ya | Algun script/FE podria usarlo; se borra en change de limpieza posterior. Migramos TODOS los callers internos a `getStageByCode` |
| 3 | Permiso RBAC config workflows/stages | `scheduling.manage` (mutaciones) + `scheduling.read` (GET) | `scheduling.write` | Configurar el tablero es administracion del modulo, distinto de operar tareas (`write`/`move_stage`). `manage` y `read` ya estan en `KNOWN_ACTIONS` |
| 4 | Idioma de codes | Ingles snake_case para stages con logica (`registered_in_iclass`, `send_to_iclass`); slug del name espanol para el resto | Todo slug espanol (`registrado_en_iclass`) | Los dos codes con logica ya viven en ingles en la intencion del codigo; mantener consistencia con la integracion |
| 5 | Mutabilidad de `code` | INMUTABLE — autogenerado al crear, nunca editable | Endpoint para editar code | Si fuera editable reintroduce el problema de rename. `CreateStageSchema` NO acepta `code` |
| 6 | `code` en migration de seed | Backfill canonico por `name->code` + slug fallback | Solo slug del name | Los 11 canonicos llevan su code de negocio exacto; cualquier stage no-canonico se slugifica |
| 7 | `listTasksInIClassStage` firma | Recibe `code` (renombrar param a `stageCode`) | Mantener `stageName` | Coherencia: TODA la resolucion de stages con logica pasa a code; el caller (`BackfillClosedServiceOrders`) ya hardcodeaba un name |
| 8 | DTO de salida de stage | `code` ADITIVO via `toStage` mapper (entity ya se serializa directa) | Nuevo StageDTO dedicado | Las routes devuelven la entity `Stage` directa; agregar `code` a la entity + mapper lo expone sin romper contrato FE |
| 9 | Slug helper ubicacion | Funcion pura en `@application/use-cases/AddStageToWorkflow.ts` (o `src/domain/`) | En el adapter Prisma | El code es regla de negocio (identidad), no detalle de persistencia. Se genera en application, el adapter solo persiste |
| 10 | Desambiguacion de colision de slug | Sufijo numerico dentro del workflow (`enviar_a_iclass`, `enviar_a_iclass_2`) | Fallar / UUID | Determinismo + legibilidad; `@@unique([workflowId, code])` garantiza no-duplicado |

## Schema & Migration

### schema.prisma (extracto modificado)

```prisma
model Stage {
  id         String          @id @default(uuid())
  workflowId String
  workflow   Workflow        @relation(fields: [workflowId], references: [id], onDelete: Cascade)
  name       String
  code       String          // identidad de negocio, inmutable, slug
  category   StageCategory
  order      Int
  color      String?
  tasks      ScheduledTask[]

  iclassResultCodes IClassResultCode[] @relation("ResultCodeMappedStage")

  @@unique([workflowId, code])
  @@index([workflowId, order])
}
```

### Mapa canonico name -> code (los 11 del seed)

| name (seed) | code |
|-------------|------|
| Nuevo | `nuevo` |
| Confirmado | `confirmado` |
| Pospuesta | `pospuesta` |
| No Factible | `no_factible` |
| Enviar a IClass | `send_to_iclass` |
| Registrado en IClass | `registered_in_iclass` |
| Notificado | `notificado` |
| En progreso | `en_progreso` |
| Instalado | `instalado` |
| Hecho | `hecho` |
| Anulado-Cancelado | `anulado_cancelado` |

Los dos con LOGICA de negocio van en ingles: `send_to_iclass` (trigger del flujo
OS) y `registered_in_iclass` (estado in-flight). El resto es slug del name
espanol. Nota: `send_to_iclass` coincide con una ACTION RBAC del mismo nombre,
pero viven en namespaces distintos (`Stage.code` vs action) — no hay colision en
DB ni en codigo.

### Migration: `prisma/migrations/20260603000000_stage_code/migration.sql`

Timestamp `20260603000000` (posterior al ultimo, `20260602000000_ticket_task_fk`).
SQL generado en dev con:

```
npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma@HEAD \
  --to-schema-datamodel prisma/schema.prisma --script
```

(el diff genera solo el `ADD COLUMN` + index; los pasos de backfill se insertan a
mano ENTRE medio, igual que en `scheduling_foundation_stage_model`). Contenido
final:

```sql
-- 1. Add nullable column (backfill-safe)
ALTER TABLE "Stage" ADD COLUMN "code" TEXT;

-- 2. Backfill deterministico e idempotente.
--    (a) Mapear los 11 canonicos por LOWER(name) -> code de negocio.
--    (b) Para cualquier otro stage: slug del name (lower, sin acentos, no-alnum -> '_').
--    (c) Desambiguar colisiones dentro del MISMO workflow con sufijo numerico.
--    Idempotente: solo toca filas con "code" IS NULL (re-run no pisa).
DO $$
DECLARE
  r RECORD;
  base_code TEXT;
  candidate TEXT;
  n INT;
BEGIN
  -- (a)+(b) primer pase: asignar base_code a todo stage sin code
  FOR r IN SELECT "id", "workflowId", "name" FROM "Stage" WHERE "code" IS NULL LOOP
    base_code := CASE LOWER(TRIM(r."name"))
      WHEN 'nuevo'                THEN 'nuevo'
      WHEN 'confirmado'           THEN 'confirmado'
      WHEN 'pospuesta'            THEN 'pospuesta'
      WHEN 'no factible'          THEN 'no_factible'
      WHEN 'enviar a iclass'      THEN 'send_to_iclass'
      WHEN 'registrado en iclass' THEN 'registered_in_iclass'
      WHEN 'notificado'           THEN 'notificado'
      WHEN 'en progreso'          THEN 'en_progreso'
      WHEN 'instalado'            THEN 'instalado'
      WHEN 'hecho'                THEN 'hecho'
      WHEN 'anulado-cancelado'    THEN 'anulado_cancelado'
      ELSE
        -- slug fallback: unaccent + lower + collapse non-alnum -> '_'
        TRIM(BOTH '_' FROM REGEXP_REPLACE(
          LOWER(TRANSLATE(r."name",
            'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
            'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC')),
          '[^a-z0-9]+', '_', 'g'))
    END;
    IF base_code IS NULL OR base_code = '' THEN
      base_code := 'stage';
    END IF;

    -- (c) desambiguar dentro del workflow
    candidate := base_code;
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM "Stage" s
      WHERE s."workflowId" = r."workflowId"
        AND s."code" = candidate
        AND s."id" <> r."id"
    ) LOOP
      n := n + 1;
      candidate := base_code || '_' || n::TEXT;
    END LOOP;

    UPDATE "Stage" SET "code" = candidate WHERE "id" = r."id";
  END LOOP;
END $$;

-- 3. Enforce: NOT NULL + unique por workflow
ALTER TABLE "Stage" ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "Stage_workflowId_code_key" ON "Stage"("workflowId", "code");
```

En prod se aplica con `npx prisma migrate deploy` (NUNCA `migrate dev`). El
backfill cubre TODOS los stages antes del `SET NOT NULL` en la misma transaccion
de migration, asi que no puede quedar a medias.

## Port Changes

### `src/domain/entities/workflow.ts`

```ts
export interface Stage {
  id: string;
  workflowId: string;
  name: string;
  code: string;          // NUEVO — identidad de negocio inmutable
  category: StageCategory;
  order: number;
  color: string | null;
}
```

### `src/domain/ports/StageRepository.ts`

`add` pasa a aceptar `code` (lo genera el use case, lo persiste el adapter):

```ts
add(workflowId: string, data: Pick<Stage, 'name' | 'code' | 'category' | 'order'>): Promise<Stage>;
findByCode(code: string, workflowId: string): Promise<Stage | null>; // helper para in-memory
```

### `src/domain/ports/SchedulingRepository.ts`

```ts
/** @deprecated Use getStageByCode. Stages se identifican por `code` (inmutable),
 *  no por `name` (editable por el usuario). Se mantiene un ciclo por compat. */
getStageByName(name: string, workflowId?: string): Promise<Stage | null>;

/** Resolve a Stage by its immutable business `code`, scoped to the workflow
 *  (the (workflowId, code) pair is unique). */
getStageByCode(code: string, workflowId: string): Promise<Stage | null>;

/** Tasks awaiting closure in the in-flight stage, resolved by `code`. */
listTasksInIClassStage(stageCode: string): Promise<ScheduledTask[]>;
```

Nota: `getStageByCode` exige `workflowId` (no opcional) porque `@@unique` es
`(workflowId, code)` — sin workflow el code no es univoco. Para
`listTasksInIClassStage` no hay workflowId disponible en el caller actual
(`BackfillClosedServiceOrders` no lo conoce), asi que el adapter resuelve por
code a traves de TODOS los workflows (igual comportamiento que hoy con name).

## Refactor por archivo (antes -> despues)

### `SendTaskToIClass.ts:13,128`

```ts
// antes
const REGISTRADO_STAGE_NAME = 'Registrado en IClass';
// ...
const stage = await this.tasks.getStageByName(REGISTRADO_STAGE_NAME, workflowId);
if (!stage) throw new StageNotFoundError(REGISTRADO_STAGE_NAME);

// despues
const REGISTRADO_STAGE_CODE = 'registered_in_iclass';
// ...
const stage = await this.tasks.getStageByCode(REGISTRADO_STAGE_CODE, workflowId!);
if (!stage) throw new StageNotFoundError(REGISTRADO_STAGE_CODE);
```

`moveToRegistrado` ya recibe `workflowId?`; como `getStageByCode` lo exige, se
mantiene el flujo (en la practica `MoveTaskToStage` siempre lo pasa). El error
`StageNotFoundError` ahora reporta el code. Comportamiento observable identico.

### `MoveTaskToStage.ts:8,24`

```ts
// antes
const ENVIAR_A_ICLASS_STAGE_NAME = 'Enviar a IClass';
// ...
if (this.sendTaskToIClass && stage.name === ENVIAR_A_ICLASS_STAGE_NAME) {

// despues
const ENVIAR_A_ICLASS_STAGE_CODE = 'send_to_iclass';
// ...
if (this.sendTaskToIClass && stage.code === ENVIAR_A_ICLASS_STAGE_CODE) {
```

`stage` viene de `this.stages.getById(stageId)` que ya devuelve la entity con
`code`. Trigger por code -> rename-safe.

### `BackfillClosedServiceOrders.ts:10,52`

```ts
// antes
const DEFAULT_IN_FLIGHT_STAGE = 'Registrado en IClass';
// opts.inFlightStageName ...
const tasks = await this.scheduling.listTasksInIClassStage(this.inFlightStageName);

// despues
const DEFAULT_IN_FLIGHT_STAGE_CODE = 'registered_in_iclass';
// renombrar opts.inFlightStageName -> opts.inFlightStageCode (mantener default)
const tasks = await this.scheduling.listTasksInIClassStage(this.inFlightStageCode);
```

Renombrar `BackfillOptions.inFlightStageName` -> `inFlightStageCode` y el campo
privado. Los tests que pasan la opcion se actualizan al code.

### `bootstrapGestionRealIngest.ts:15,71`

```ts
// antes
const PENDING_STAGE_NAME = 'Pendiente';
// ...
let defaultStageId = (await scheduling.getStageByName(PENDING_STAGE_NAME))?.id ?? '';

// despues
const PENDING_STAGE_CODE = 'pendiente';
// ...
let defaultStageId = (await scheduling.getStageByCode(PENDING_STAGE_CODE, /* sin wf */))?.id ?? '';
```

OJO: `getStageByCode` exige `workflowId`, pero aca NO hay workflow conocido (es
el fallback needs-review sin proyecto). DECISION: agregar una sobrecarga
documentada o mantener este unico caller usando un nuevo helper
`findStageByCodeAnyWorkflow(code)` en el port, o dejar `getStageByName` deprecado
SOLO para este caso de fallback best-effort (no es logica critica: el comentario
del archivo dice que es last-resort). Recomendacion: usar
`listTasksInIClassStage`-style lookup -> agregar `getStageByCodeAnyWorkflow(code):
Promise<Stage|null>` al port para este fallback, y reservar `getStageByCode(code,
workflowId)` para la logica scoped. NO existe stage `pendiente` en el seed
canonico (es best-effort), asi que el fallback al initial-stage del proyecto
sigue siendo el camino real.

### `PrismaSchedulingRepository.ts:542`

```ts
// agregar (mantener getStageByName deprecado para compat)
async getStageByCode(code: string, workflowId: string): Promise<Stage | null> {
  const row = await (prisma.stage as any).findFirst({ where: { code, workflowId } });
  if (!row) return null;
  return { id: row.id, workflowId: row.workflowId, name: row.name,
           code: row.code, category: row.category, order: row.order, color: row.color ?? null };
}

// listTasksInIClassStage: resolver por code (sin workflowId -> primer stage con ese code)
async listTasksInIClassStage(stageCode: string): Promise<ScheduledTask[]> {
  const stage = await (prisma.stage as any).findFirst({ where: { code: stageCode } });
  if (!stage) return [];
  const rows = await (prisma.scheduledTask as any).findMany({ where: { stageId: stage.id }, include: INCLUDE });
  return rows.map(toTask);
}
```

Agregar `code: row.code` en los objetos `Stage` devueltos por `getStageByName`,
`getInitialStage` y cualquier otra proyeccion de stage en este adapter.

### `InMemoryStageRepository.ts:98` + `InMemorySchedulingRepository.ts:392,426`

- `InMemoryStageRepository`: `add` setea `code` desde `data.code`; agregar
  `findByCode(code, workflowId)`; agregar `code` al objeto en `addDirect`.
- `InMemorySchedulingRepository`: agregar `getStageByCode` que delega en
  `stageRepo.findByCode`; `getStageByName` queda deprecado; `listTasksInIClassStage`
  pasa a resolver por `findByCode`.

## Creacion de stage: autogeneracion del code

`AddStageToWorkflow.ts` genera el `code` por slug del `name` con desambiguacion
dentro del workflow (espeja el SQL del backfill):

```ts
function slugifyStageCode(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'stage';
}

// dentro de execute(), tras validar nombre duplicado:
const base = slugifyStageCode(data.name);
const used = new Set(wf.stages.map(s => s.code));
let code = base, n = 1;
while (used.has(code)) { n += 1; code = `${base}_${n}`; }
return this.stages.add(workflowId, { ...data, code });
```

`CreateStageSchema` NO se modifica para aceptar `code` (input no editable) —
inmutabilidad por construccion. Los use cases `UpdateStageColor` / `ReorderStages`
NUNCA tocan `code`. No existe endpoint de edicion de code.

## DTO de salida

Las routes devuelven la entity `Stage` directa (no hay StageDTO dedicado). El
campo `code` se agrega a:
- `src/domain/entities/workflow.ts` (entity).
- `src/infrastructure/adapters/prisma/PrismaWorkflowRepository.ts` `toStage` (linea 5-14): agregar `code: row.code`.
- `INCLUDE_STAGES` ya trae todas las columnas (`stages: true`), no cambia.

`code` es ADITIVO: ningun campo previo (`id`, `name`, `category`, `order`,
`color`) se quita ni renombra. El contrato FE no se rompe; `name` sigue siendo el
label.

## RBAC en workflows.routes.ts

Patron identico a `createGestionRealSyncRouter` (app.ts:926-928, recibe
`requirePerm` como parametro). Cambios:

1. `createWorkflowsRouter` agrega un parametro `requirePerm: (m, a) => RequestHandler`
   (igual que el factory exportado en `app.ts:486`).
2. Cada ruta encadena el permiso DESPUES de `auth`:
   - GET (workflows, /:id, stages implicitas) -> `requirePerm('scheduling', 'read')`
   - POST/PUT/DELETE/PATCH de workflow y stage -> `requirePerm('scheduling', 'manage')`

```ts
// firma
export function createWorkflowsRouter(
  authProvider: AuthProvider,
  requirePerm: (m: RbacModuleCode, a: PermissionAction) => RequestHandler,
  listWorkflows: ListWorkflows, /* ...resto igual... */
): Router {
  // ...
  router.get('/workflows', auth, requirePerm('scheduling', 'read'), handler);
  router.post('/workflows', auth, requirePerm('scheduling', 'manage'), handler);
  router.put('/workflows/:id', auth, requirePerm('scheduling', 'manage'), handler);
  router.delete('/workflows/:id', auth, requirePerm('scheduling', 'manage'), handler);
  router.post('/workflows/:id/stages', auth, requirePerm('scheduling', 'manage'), handler);
  router.put('/workflows/:id/stages/reorder', auth, requirePerm('scheduling', 'manage'), handler);
  router.delete('/workflows/:id/stages/:stageId', auth, requirePerm('scheduling', 'manage'), handler);
  router.patch('/workflows/:id/stages/:stageId/color', auth, requirePerm('scheduling', 'manage'), handler);
}
```

Wiring en `app.ts:890`: insertar `requirePerm` como 2do argumento. Claves
exactas: modulo `'scheduling'`, actions `'read'` y `'manage'` (ambas en
`KNOWN_ACTIONS`). `super_admin` short-circuitea (no se ve afectado). Las rutas de
`project-categories`/`project-types` que viven en el mismo router siguen el mismo
criterio (GET -> read, mutaciones -> manage) para consistencia.

Coordinacion: asignar `scheduling.manage` a los roles que hoy operan config de
tablero (sino quedan en 403). Documentado como dependencia FE/seed-RBAC.

## Plan TDD — 6 commits atomicos

| # | Commit | Test RED primero | Codigo que pone GREEN | Archivos de test |
|---|--------|------------------|------------------------|------------------|
| 1 | `feat(scheduling): Stage.code schema + migration + backfill` | (gate: `migrate deploy` en copia + verificar code NOT NULL/unico) | schema.prisma + migration.sql | — (verificacion manual + `tsc`) |
| 2 | `feat(scheduling): code en entity + getStageByCode (TDD)` | test in-memory: `findByCode`/`getStageByCode` resuelve por code; `add` persiste code | entity `Stage.code`, port `getStageByCode`/`findByCode`, in-memory adapters | `InMemoryStageRepository`/`InMemorySchedulingRepository` (nuevo test o ampliar existente) |
| 3 | `refactor(scheduling): resolver stages por code (TDD)` | actualizar fixtures/asertos a `code` en cada test -> RED | `SendTaskToIClass`, `MoveTaskToStage`, `BackfillClosedServiceOrders`, `bootstrapGestionRealIngest` | `SendTaskToIClass.test.ts`, `MoveTaskToStage.test.ts`, `BackfillClosedServiceOrders.test.ts`, `IngestClosedServiceOrders.test.ts`, `getStageByName.workflow.test.ts` -> `getStageByCode.workflow.test.ts`, `IClassClosureScheduler.test.ts` |
| 4 | `feat(scheduling): code en DTO + autogeneracion en AddStage (TDD)` | test: crear stage autogenera code slug; rename de name NO cambia code; DTO incluye code | `AddStageToWorkflow` (slug+desambiguacion), `toStage` mapper, Prisma adapter persiste code | `WorkflowUseCases.test.ts` (asercion code autogenerado), test de rename-safe |
| 5 | `feat(scheduling): seed setea code en 11 canonicos` | (gate: re-run seed idempotente, code presente) | `prisma/seed.ts` mapa name->code | — (verificacion: seed idempotente) |
| 6 | `feat(scheduling): RBAC manage/read en rutas workflows/stages (TDD)` | test integracion: 401 sin token, 403 sin permiso, 200/201 con permiso, super_admin pasa | `createWorkflowsRouter` recibe `requirePerm`; wiring app.ts | `scheduling.routes.test.ts` (o nuevo `workflows.routes.rbac.test.ts`) |

Orden justificado: schema bloquea ports (2); ports bloquean el refactor (3); el
refactor estable habilita DTO + autogeneracion (4); seed (5) y RBAC (6) son
ortogonales y van al final. Correr suite COMPLETA al cierre del commit 3 y del 6.
Cada commit pasa `tsc --noEmit` + `npm test` antes de avanzar. Conventional
commits, sin `Co-Authored-By`.

## Riesgos de migracion en prod y rollback

| Riesgo | Prob | Mitigacion |
|--------|------|------------|
| Backfill deja `code` NULL -> falla `SET NOT NULL` | Med | El `DO $$` cubre TODOS los stages (canonicos + slug fallback + `'stage'` ultimo recurso) ANTES del `SET NOT NULL`, misma migration atomica. Probar en copia de prod antes de `migrate deploy` |
| Algun canonico ya fue RENOMBRADO en prod antes de migrar | Low | Verificar nombres canonicos intactos en prod antes de migrar; si alguno cambio, ajustar el mapa del `DO $$` por id/nombre actual |
| Colision de slug en el mismo workflow | Med | Sufijo numerico deterministico en el `DO $$` y en `AddStageToWorkflow`; `@@unique([workflowId, code])` lo garantiza |
| Romper >300 tests por el refactor | Med | TDD por archivo (red->green), no big-bang; suite completa al cierre de commit 3 y 6 |
| Rutas quedan detras de permiso que ningun rol tiene -> 403 global | Med | Coordinar seed-RBAC: asignar `scheduling.manage` a roles operativos antes/junto con commit 6; `super_admin` short-circuit |
| Contrato FE roto por DTO | Low | `code` es ADITIVO; nada se quita ni renombra |

### Rollback

- Cada commit revertible via `git revert <sha>` independiente.
- Migration: `code` es aditiva. En prod, dejar la columna NO rompe codigo viejo
  (la ignora). Rollback formal: `prisma migrate resolve --rolled-back
  20260603000000_stage_code` + `ALTER TABLE "Stage" DROP COLUMN "code"` manual si
  fuese imprescindible.
- Revertir commit 3 (refactor) deja schema+ports nuevos intactos y la logica
  vuelve a resolver por name (comportamiento previo, `getStageByName` deprecado
  pero funcional).
- Revertir SOLO commit 6 devuelve las rutas a `auth`-only sin tocar el resto.
- `migrate deploy` + backfill idempotente: re-correr no duplica ni pisa codes
  ya seteados (solo toca `code IS NULL`).

## Open Questions

- [ ] `bootstrapGestionRealIngest` fallback `'pendiente'`: confirmar si se agrega
  `getStageByCodeAnyWorkflow(code)` al port (recomendado, limpio) o se deja
  `getStageByName` deprecado solo para ese caso best-effort. No es logica
  critica (el camino real es `getInitialStage` del proyecto).
- [ ] Seed-RBAC: que rol(es) reciben `scheduling.manage` para no quedar en 403.
  Coordinar con FE/seed antes del deploy del commit 6.
