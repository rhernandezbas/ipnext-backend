# Proposal: scheduling-stage-code

## Intent

Hoy la logica de negocio de scheduling identifica stages por su NOMBRE (string
literal hardcodeado), por ejemplo `"Registrado en IClass"` y `"Enviar a IClass"`.
Esto es fragil: pronto habra una UI de configuracion que permitira RENOMBRAR
estados, y un rename romperia la integracion con IClass EN SILENCIO (sin error de
compilacion, sin test rojo en runtime de prod). El stage seguiria existiendo pero
`getStageByName('Registrado en IClass')` devolveria null, y la tarea quedaria sin
avanzar.

Este cambio introduce un campo `code` INMUTABLE (slug estable) en `Stage`. El
`code` pasa a ser la IDENTIDAD estable del stage para toda la logica de negocio;
el `name` queda como label editable por el usuario. Toda referencia por nombre se
migra a referencia por `code`. Ademas, como toca rutas de configuracion de
workflows/stages, se aplica el permiso granular RBAC que hoy falta (las rutas solo
chequean `auth`, sin `module.action`).

## Scope

### In Scope

- Migration Prisma aditiva: agregar `Stage.code String` en dos pasos (nullable ->
  backfill deterministico -> NOT NULL) + constraint de unicidad.
- Backfill idempotente de los stages existentes en prod: derivar `code` del `name`
  actual via slug, con mapeo explicito de los stages canonicos conocidos del seed
  (ej. `"Registrado en IClass"` -> `registered_in_iclass`).
- Entidad de dominio `Stage`: agregar `code: string`.
- Port `StageRepository` + `SchedulingRepository`: nuevo metodo `getStageByCode`
  (reemplaza el uso de `getStageByName` para logica de negocio; `getStageByName`
  puede quedar deprecado o eliminarse segun decision en Open Questions).
- Refactor (TDD: test primero) de TODAS las referencias por nombre encontradas:
  `SendTaskToIClass`, `MoveTaskToStage`, `BackfillClosedServiceOrders`,
  `bootstrapGestionRealIngest`, y sus tests.
- Exponer `code` en el DTO de stage (salida de workflows/stages) sin romper el
  contrato que el FE ya consume (campo aditivo).
- Asignacion de `code` al crear un stage nuevo desde la UI (autogenerado del name).
- `seed.ts` y la migration de seed: setear `code` de aca en mas.
- Aplicar permiso granular RBAC (`requirePerm`) a las rutas de
  `workflows.routes.ts` (workflows + stages CRUD).

### Out of Scope (EXPLICITO)

- Permitir editar `code` post-creacion (es INMUTABLE por decision; no se expone
  endpoint de edicion de code).
- Refactorizar las rutas de `scheduling.routes.ts` (tareas) para agregarles
  permisos granulares -> ese es un change aparte (`scheduling-routes-rbac`); aca
  solo se tocan workflows/stages porque es la superficie que este change ya abre.
- UI de configuracion de stages (vive en el frontend; este change solo prepara el
  contrato BE: campo `code` en el DTO + permiso).
- Renombrar / introducir `category` como identidad -> `category` sigue siendo un
  agrupador de UI (nuevo/enProgreso/hecho), no identidad de negocio.
- Migrar el modelo a `@@unique([workflowId, name])` (hoy la unicidad de name es
  por validacion en use case, no constraint DB; no se cambia eso aca).

## Capabilities

### New Capabilities

- `stage-stable-code`: cada `Stage` tiene un `code` inmutable que es su identidad
  de negocio. La logica de scheduling (integracion IClass, ingest GR) resuelve
  stages por `code`, nunca por `name`. Renombrar un stage desde la UI NO rompe la
  logica.

### Modified Capabilities

- `scheduling` (spec existente en `openspec/specs/scheduling/spec.md`): los
  requisitos que hoy dicen "mover a Registrado en IClass" se reexpresan en
  terminos de `code` (`registered_in_iclass`), manteniendo el comportamiento
  observable identico.
- `scheduling-workflows` (spec existente): el modelo de Stage incorpora `code`;
  el contrato de salida del stage incluye `code`; las rutas de workflows/stages
  pasan a requerir permiso granular.

## Approach

Estrategia: **6 commits atomicos**, cada uno reversible via `git revert`, con
dependencias hacia adelante. La migration es en dos pasos DENTRO de un mismo
archivo de migration (nullable -> backfill -> NOT NULL) para que `migrate deploy`
en prod sea atomico y no deje la columna a medias.

1. **Commit 1 - Schema + migration + backfill**: `prisma/schema.prisma` agrega
   `code String` a `Stage` (con `@@unique([workflowId, code])`, ver Open Q1). La
   migration SQL: (a) `ADD COLUMN "code" TEXT;` (nullable); (b) `UPDATE` de
   backfill deterministico siguiendo un `DO $$` block idempotente igual al patron
   de `20260520000000_scheduling_foundation_stage_model` -- mapea los 11 stages
   canonicos conocidos a sus codes y para cualquier otro deriva slug del name; (c)
   `ALTER COLUMN "code" SET NOT NULL;`; (d) crear el indice unico. Bloquea todo lo
   demas.
2. **Commit 2 - Domain + ports (TDD)**: agrega `code` a la entidad `Stage`;
   agrega `getStageByCode(code, workflowId?)` a `StageRepository` y/o
   `SchedulingRepository`; in-memory adapters implementan el lookup por code.
   Tests de los adapters in-memory primero (rojo -> verde).
3. **Commit 3 - Refactor logica de negocio (TDD)**: reemplaza cada referencia por
   nombre por su `code`. Orden por archivo: actualizar el test primero (cambiar el
   fixture/aserto a `code`), ver rojo, luego el use case. Archivos:
   `SendTaskToIClass` (`registered_in_iclass`), `MoveTaskToStage`
   (`send_to_iclass` / ver Open Q4 por colision de nombre con la action RBAC),
   `BackfillClosedServiceOrders` (in-flight stage por code),
   `bootstrapGestionRealIngest` (`Pendiente` -> code pendiente). Tambien
   `listTasksInIClassStage` pasa a recibir code.
4. **Commit 4 - DTO + creacion de stage**: el DTO de salida de stage incluye
   `code`. `AddStageToWorkflow` autogenera `code` del `name` (slug) al crear; el
   `CreateStageSchema` NO acepta `code` como input editable (inmutabilidad). El
   adapter Prisma persiste el `code` generado.
5. **Commit 5 - Seed**: `prisma/seed.ts` agrega `code` a cada uno de los 11 stages
   canonicos (mapa explicito). La migration de seed equivalente tambien.
6. **Commit 6 - RBAC en rutas de workflows/stages**: `createWorkflowsRouter`
   recibe `requirePerm` (igual que `createGestionRealSyncRouter`); cada ruta
   mutante de workflow/stage encadena `requirePerm('scheduling', '<accion>')`
   despues de `auth`. Wiring en `app.ts`. Tests de integracion: 401/403/200.

Justificacion del orden: schema bloquea ports; ports bloquean el refactor; el
refactor estable habilita exponer el DTO y la autogeneracion; seed y RBAC son
ortogonales y van al final para no mezclar con el core del rename-safe.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | `Stage.code String` + `@@unique([workflowId, code])` |
| `prisma/migrations/<ts>_stage_code/` | New | ADD COLUMN nullable + backfill DO$$ idempotente + SET NOT NULL + unique index |
| `prisma/seed.ts` | Modified | `code` en los 11 stages canonicos (mapa explicito) |
| `src/domain/entities/workflow.ts` | Modified | `Stage.code: string` |
| `src/domain/ports/StageRepository.ts` | Modified | `getStageByCode` (o equivalente); `add` acepta `code` |
| `src/domain/ports/SchedulingRepository.ts` | Modified | `getStageByCode`; `listTasksInIClassStage` por code; deprecar `getStageByName` (Open Q2) |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Modified | impl `getStageByCode`, mapear `code` en proyecciones |
| `src/infrastructure/adapters/prisma/PrismaStageRepository.ts` | Modified | mapear/persistir `code` |
| `src/infrastructure/adapters/in-memory/InMemoryStageRepository.ts` | Modified | `findByCode` + `code` en `add` |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | Modified | `getStageByCode`, `listTasksInIClassStage` por code |
| `src/application/use-cases/SendTaskToIClass.ts` | Modified | `REGISTRADO_STAGE_NAME` -> code `registered_in_iclass` |
| `src/application/use-cases/MoveTaskToStage.ts` | Modified | `ENVIAR_A_ICLASS_STAGE_NAME` -> code `send_to_iclass` (Open Q4) |
| `src/application/use-cases/BackfillClosedServiceOrders.ts` | Modified | in-flight stage por code |
| `src/application/use-cases/AddStageToWorkflow.ts` | Modified | autogenerar `code` del `name` al crear |
| `src/infrastructure/scheduling/bootstrapGestionRealIngest.ts` | Modified | `PENDING_STAGE_NAME` -> code |
| `src/application/dto/workflows.dto.ts` | Modified | `code` en DTO de salida (no en input de creacion) |
| `src/infrastructure/http/routes/workflows.routes.ts` | Modified | `requirePerm('scheduling', ...)` en rutas mutantes |
| `src/infrastructure/http/app.ts` | Modified | pasar `requirePerm` a `createWorkflowsRouter` |
| `src/__tests__/application/SendTaskToIClass.test.ts` | Modified | fixtures/asertos por `code` |
| `src/__tests__/application/MoveTaskToStage.test.ts` | Modified | idem |
| `src/__tests__/application/BackfillClosedServiceOrders.test.ts` | Modified | idem |
| `src/__tests__/application/IngestClosedServiceOrders.test.ts` | Modified | fixture `code` en Stage |
| `src/__tests__/infrastructure/getStageByName.workflow.test.ts` | Modified/Renamed | -> `getStageByCode.workflow.test.ts` |
| `src/__tests__/infrastructure/IClassClosureScheduler.test.ts` | Modified | fixture `code` |
| `src/__tests__/infrastructure/scheduling.routes.test.ts` | Modified | fixtures `code`; tests RBAC si aplica |
| `src/__tests__/application/WorkflowUseCases.test.ts` | Modified | asercion de `code` autogenerado |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Backfill deja stages con `code` null -> falla `SET NOT NULL` en prod | Med | El UPDATE de backfill cubre TODOS los stages (mapa canonico + slug fallback del name). El `SET NOT NULL` corre DESPUES del UPDATE en la misma migration. Probar en copia de prod antes de `migrate deploy` |
| Colision de `code` (dos stages homonimos en el mismo workflow tras slug) | Med | `@@unique([workflowId, code])`. El slug fallback debe ser deterministico; si colisiona, sufijo numerico. Los 11 canonicos no colisionan (nombres distintos) |
| Rename silencioso ya en prod ANTES de este change (algun stage ya fue renombrado) | Low | Verificar en prod que los nombres canonicos siguen intactos antes de migrar. Si alguno fue renombrado, ajustar el mapa de backfill por id/nombre actual |
| Romper el contrato del FE al cambiar el DTO | Low | `code` es ADITIVO; no se quita ni renombra ningun campo existente del stage DTO. Coordinar con FE que `name` sigue siendo el label |
| Romper >300 tests existentes por el refactor | Med | TDD por archivo (rojo->verde), no big-bang. Correr suite completa al final del commit 3 y del 6. Cero tolerancia a romper tests no relacionados |
| `getStageByName` aun usado por algun caller no detectado | Low | rg exhaustivo ya hecho (ver lista en notas). Mantener `getStageByName` deprecado un commit antes de borrarlo (Open Q2) |
| Las rutas de workflows quedan detras de un permiso que ningun rol tiene -> 403 para todos | Med | Coordinar con FE/seed RBAC: asignar `scheduling.manage` (o `scheduling.write`) a los roles que hoy ya operan config. `super_admin` no se ve afectado (short-circuit) |

## Rollback Plan

- Cada commit es revertible via `git revert <sha>` de forma independiente.
- Migration: la columna `code` es aditiva. Rollback en prod = `prisma migrate
  resolve --rolled-back <migration>` + DROP COLUMN manual si fuese imprescindible;
  en la practica dejar la columna no rompe nada (es ignorada por codigo viejo).
- Si el commit 3 (refactor) rompe algo, revertirlo deja el schema + ports nuevos
  intactos y la logica vuelve a resolver por nombre (comportamiento previo).
- Si el commit 6 (RBAC) deja a usuarios fuera (403), revertir SOLO el 6 devuelve
  las rutas a `auth`-only sin tocar el resto.
- En prod se usa `migrate deploy` (NO `migrate dev`); el backfill es idempotente,
  re-correr la migration no duplica ni pisa codes ya seteados.

## Dependencies

- Prisma 7 ya instalado.
- `model Stage` + `model Workflow` ya existen (scheduling-foundation-stage-model).
- RBAC: catalogo `scheduling` con actions `read/write/delete/manage/move_stage/...`
  ya existe en `src/domain/entities/rbac.ts`. `requirePermission` +
  `requirePerm` factory ya existen en `app.ts`.
- FE: depende de que el FE consuma `code` (no `name`) para identificar stages en
  llamadas de logica, y de que se asigne el permiso `scheduling.*` elegido a los
  roles operativos. **Nota de coordinacion FE**: clave de permiso definitiva en
  Open Q3.

## Success Criteria

- [ ] `prisma migrate dev` corre sin error en entorno limpio y deja `code` NOT NULL.
- [ ] Backfill: todos los stages existentes quedan con `code` no null y unico por workflow (verificable con `prisma studio`).
- [ ] Re-ejecutar el seed es idempotente y setea `code` en los 11 canonicos.
- [ ] Ningun archivo de `src/application/` ni `src/infrastructure/scheduling/` resuelve stages por string literal de nombre (verificable por rg de los literales).
- [ ] El DTO de salida de stage incluye `code`; ningun campo previo se quito ni renombro.
- [ ] Crear un stage nuevo via `POST /workflows/:id/stages` autogenera un `code` slug del `name`; `code` NO es input editable.
- [ ] Renombrar un stage (cambiar `name`) NO cambia su `code` ni rompe la integracion IClass (test que renombra y luego envia a IClass).
- [ ] Rutas mutantes de workflows/stages devuelven 403 sin permiso, 200/201 con permiso, 401 sin token.
- [ ] `super_admin` sigue pasando todas las rutas (short-circuit).
- [ ] Application no importa de `@infrastructure/*` (DIP intacto).
- [ ] Todos los tests existentes siguen pasando; tests nuevos cubren rename-safe + RBAC.
- [ ] `tsc --noEmit` con 0 errores.

## Open Questions

1. **Unicidad de `code`: global vs por workflow.** Recomendacion -> **unique por
   workflow (`@@unique([workflowId, code])`)**. Justificacion: el mismo flujo
   logico (`registered_in_iclass`) puede existir en varios workflows distintos
   (ya hay homonimos hoy, y `getStageByName` recibe `workflowId` justamente para
   desambiguar). Un unique global obligaria a codes artificiales por workflow y
   rompe la semantica "este code = este paso del flujo" repetible entre workflows.
   La logica de negocio ya pasa `workflowId` al resolver. Confirmas unique por
   workflow?

2. **Que hacemos con `getStageByName`.** Recomendacion -> **deprecarlo, no
   borrarlo en este change**. Migramos todos los callers a `getStageByCode`, pero
   dejamos `getStageByName` un ciclo mas por si el FE o un script lo usa.
   Borrarlo definitivamente en un change de limpieza posterior. Confirmas
   deprecar (vs borrar ya)?

3. **Clave de permiso para las rutas de workflows/stages.** Recomendacion ->
   **`scheduling.manage`** para las mutaciones de configuracion (crear/editar/
   borrar workflow, agregar/quitar/reordenar/recolorear stage) y **`scheduling.read`**
   para los GET. Justificacion: configurar workflows/stages es administracion del
   modulo, no operacion diaria de tareas (que usa `write`/`move_stage`). Esto
   separa "operar tareas" de "configurar el tablero". Alternativa: `scheduling.write`
   si no se quiere distinguir. Cual preferis: `manage` o `write`?

4. **Code canonico para "Enviar a IClass".** Ojo: ya existe una ACTION RBAC
   llamada `send_to_iclass`. El `code` del stage vive en otro namespace
   (`Stage.code`, no es una action), asi que no hay colision tecnica, pero para
   evitar confusion humana, recomendacion -> stage code `send_to_iclass` igual
   (es el nombre natural y no colisiona en DB). Codes canonicos propuestos para
   los 11 stages del seed: `nuevo`, `confirmado`, `pospuesta`, `no_factible`,
   `send_to_iclass`, `registered_in_iclass`, `notificado`, `en_progreso`,
   `instalado`, `hecho`, `anulado_cancelado`. Confirmas este mapa, o preferis
   prefijar los codes de stage (ej. `stage_send_to_iclass`) para diferenciarlos
   visualmente de las actions?

5. **Idioma de los codes.** Los dos codes con logica de negocio HOY estan en
   ingles en el codigo (`registered_in_iclass` deriva de la intencion, no del
   slug literal del name en espanol). Recomendacion -> **codes en ingles snake_case**
   para los stages con logica (`registered_in_iclass`, `send_to_iclass`) y slug
   del name en espanol para el resto (`no_factible`, `anulado_cancelado`).
   Alternativa: TODO en slug del name espanol -> `registrado_en_iclass`. Cual
   preferis para consistencia?
