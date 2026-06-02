# Verify Report: scheduling-stage-code

**Fecha**: 2026-06-02
**Rama**: feat/scheduling-stage-code
**Veredicto global**: PASS

---

## Resumen

El change `scheduling-stage-code` esta COMPLETAMENTE implementado y verde.
Todos los requisitos de ambas specs estan cumplidos, la suite completa pasa sin
fallos, `tsc --noEmit` emite 0 errores, la migracion SQL cubre los 3 pasos del
design, y no quedan literales de nombre de stage en logica de negocio.

No se detectaron hallazgos CRITICAL. Se registran 2 WARNING menores y 2
SUGGESTION de calidad.

---

## Gate

| Gate | Resultado |
|------|-----------|
| `npx tsc --noEmit` | 0 errores |
| `npm test` | 1924 passed, 86 skipped, 0 failed (2010 total; 6 suites skipped) |

---

## Trazabilidad REQ

### Spec: stage-stable-code

| REQ | Descripcion | Estado | Evidencia (ruta:linea) |
|-----|-------------|--------|------------------------|
| REQ-CODE-1 | `code` inmutable, no aceptado en input | CUMPLE | `src/application/dto/workflows.dto.ts:5-9` — `CreateStageSchema` sin campo `code`; `src/application/use-cases/AddStageToWorkflow.ts:44-47` — `code` autogenerado en use case, ignorado si el caller lo enviara |
| REQ-CODE-2 | Slug autogenerado del `name` | CUMPLE | `src/application/use-cases/AddStageToWorkflow.ts:11-19` (`slugifyStageCode`); tests T-23 en `WorkflowUseCases.test.ts:173-200` |
| REQ-CODE-3 | `@@unique([workflowId, code])` | CUMPLE | `prisma/schema.prisma:476`; migration step 3 crea `Stage_workflowId_code_key` |
| REQ-CODE-4 | `getStageByCode` en ports + adapters | CUMPLE | `src/domain/ports/SchedulingRepository.ts:58`; `src/domain/ports/StageRepository.ts:7`; Prisma adapter: `PrismaSchedulingRepository.ts:557-568`; `PrismaStageRepository.ts:51-53`; InMemory: `InMemorySchedulingRepository.ts:402-405`; `InMemoryStageRepository.ts:48-51` |
| REQ-CODE-5 | `getStageByName` marcado `@deprecated` | CUMPLE | `src/domain/ports/SchedulingRepository.ts:51-53`; `InMemorySchedulingRepository.ts:392`; `PrismaSchedulingRepository.ts:542` — ningun caller en application/ ni scheduling/ llama `getStageByName` |
| REQ-LOGIC-1 | 0 literales de nombre de stage en application/ y infrastructure/scheduling/ | CUMPLE | `rg "Registrado en IClass\|Enviar a IClass\|Pendiente" src/application src/infrastructure/scheduling` -> 0 matches en codigo logico (solo comentarios JSDoc); `getStageByName` no tiene callers en esos paths |
| REQ-BACKFILL-1 | Migration idempotente, mapa canonico, WHERE code IS NULL | CUMPLE | `prisma/migrations/20260603000000_stage_code/migration.sql` — Paso 1: ADD COLUMN TEXT; Paso 2: DO $$ con los 11 canonicos + slug fallback + sufijo numerico, condicion `WHERE "code" IS NULL`; Paso 3: SET NOT NULL + CREATE UNIQUE INDEX |
| REQ-DTO-1 | `code` aditivo en salida de stage | CUMPLE | `src/domain/entities/workflow.ts:8`; `PrismaWorkflowRepository.ts:10`; `PrismaStageRepository.ts:17`; `PrismaSchedulingRepository.ts:550,564,582` — todos los mappers incluyen `code: row.code` |
| REQ-RBAC-1 | `scheduling.manage` en rutas mutantes | CUMPLE | `src/infrastructure/http/routes/workflows.routes.ts:80,102,120,142,165,187,209,226,264,282,304,341,359,381` — todas las rutas mutantes encadenan `canManage`; factory `requirePerm` recibido como parametro (DIP-clean) |
| REQ-RBAC-2 | `scheduling.read` en GETs | CUMPLE | `workflows.routes.ts:84,89,246,251,323,328` — todos los GET encadenan `canRead` |
| REQ-DIP-1 | Application no importa de infrastructure | CUMPLE | `rg "from.*@infrastructure" src/application/` -> 0 matches en logica de negocio (solo un comentario de invariante en `ListSessionHistory.ts:4`) |

### Spec: scheduling (delta)

| REQ | Descripcion | Estado | Evidencia |
|-----|-------------|--------|-----------|
| REQ-MOVE-STAGE-1 | `MoveTaskToStage` detecta stage por `stage.code === "send_to_iclass"` | CUMPLE | `MoveTaskToStage.ts:8,25`; test rename-safe en `MoveTaskToStage.test.ts:85-120` |
| REQ-MOVE-OS-1 | `SendTaskToIClass` avanza a stage por `getStageByCode("registered_in_iclass", workflowId)` | CUMPLE | `SendTaskToIClass.ts:14,129`; test rename-safe en `SendTaskToIClass.test.ts:292` |
| REQ-BACKFILL-STAGE-1 | `BackfillClosedServiceOrders` resuelve stage por `inFlightStageCode` | CUMPLE | `BackfillClosedServiceOrders.ts:10,52`; `BackfillClosedServiceOrders.test.ts:104` — opcion `inFlightStageCode` testeada |
| REQ-INGEST-STAGE-1 | `bootstrapGestionRealIngest` usa `getStageByCode("pendiente", wfId)` con fallback a `getInitialStage` | CUMPLE | `bootstrapGestionRealIngest.ts:21,84-89` — constante `PENDING_STAGE_CODE = 'pendiente'`, estrategia code-first luego fallback, warning si falla |
| REQ-LIST-ICLASS-1 | `listTasksInIClassStage` recibe `stageCode`, filtra por `Stage.code` | CUMPLE | `SchedulingRepository.ts:80`; `PrismaSchedulingRepository.ts:612-620`; `InMemorySchedulingRepository.ts:428-438`; test en `InMemorySchedulingRepository.test.ts:68` |

---

## Hallazgos

### WARNING

**W-01**: La spec REQ-CODE-1 exige el scenario "Enviar code en edicion es ignorado"
(`PATCH /api/workflows/:workflowId/stages/:stageId` con `{ "code": "otro_code" }`).
No existe un endpoint de edicion de stage (no hay `UpdateStage` use case en el
router; solo `UpdateStageColor` y `ReorderStages`). El scenario es inaplicable en
el estado actual: no hay ruta que permita mutar un stage mas alla del color y el
orden. La intencion del REQ esta cubierta por construccion (no existe endpoint),
pero no hay un test automatizado que documente esa ausencia.

**W-02**: `seed.ts:356-388` asigna `scheduling.manage` al rol `administrador`
(nombre en el sistema RBAC). El tasks.md (T-29) y el design dicen rol `admin`.
El seed usa el codigo correcto del sistema real (`administrador`), pero la
nomenclatura en artefactos SDD puede confundir en revisiones futuras. El
comportamiento en runtime es correcto.

### SUGGESTION

**S-01**: `InMemorySchedulingRepository.listTasksInIClassStage` accede
internamente a `(stageRepo as any).stages` (campo privado del InMemoryStageRepository)
en lugar de usar la API publica `findByCode`. Funciona en tests porque la clase
concreta expone el campo, pero es frágil ante refactors del in-memory adapter.
Ruta: `InMemorySchedulingRepository.ts:432-434`.

**S-02**: El scenario de rename-safe en `WorkflowUseCases.test.ts` (T-23) cubre
que el `code` autogenerado es correcto al CREAR y que un input `code` se ignora,
pero no tiene un test explícito de que llamar a `UpdateStageColor` o `ReorderStages`
despues de crear no altera el `code`. El `getStageByCode.workflow.test.ts:44` cubre
el caso a nivel de repositorio (rename via fixture directo), que es suficiente dado
que ningun use case mutante toca el campo `code` en el schema o en la firma del
adapter. Cobertura aceptable, pero un test end-to-end de "crear stage -> color ->
verificar code intacto" lo haría explícito para la spec REQ-CODE-1 scenario 3.

---

## Verificacion adicional

### Migration SQL
`prisma/migrations/20260603000000_stage_code/migration.sql` — 3 pasos confirmados:
1. `ALTER TABLE "Stage" ADD COLUMN "code" TEXT;` (nullable)
2. `DO $$ ... END $$;` — mapa 11 canonicos + slug fallback + sufijo numerico; condicion
   `WHERE "code" IS NULL` garantiza idempotencia
3. `ALTER TABLE "Stage" ALTER COLUMN "code" SET NOT NULL;` +
   `CREATE UNIQUE INDEX "Stage_workflowId_code_key" ON "Stage"("workflowId", "code");`

### schema.prisma
`prisma/schema.prisma:467,476` — campo `code String` (sin `@default`) +
`@@unique([workflowId, code])` confirmados.

### Seed
`prisma/seed.ts:243-292` — 11 stages canonicos con `code` explicito segun mapa del
design. Upsert por `code` primero, fallback por `name` para filas pre-migracion.
`prisma/seed.ts:356-388` — `scheduling.manage` + `scheduling.read` asignados al
rol `administrador` via upsert idempotente.

### DIP
`rg "from.*@infrastructure" src/application/` — 0 matches en logica de negocio.
`rg "from.*@prisma/client" src/application/` — 0 matches.

### Bug "Pendiente" corregido
`bootstrapGestionRealIngest.ts:21-96` — el codigo nunca llama `getStageByName("Pendiente")`.
Usa `getStageByCode(PENDING_STAGE_CODE, wfId)` con fallback a `getInitialStage(wfId)` y
warning si ninguno resuelve. El `defaultStageId` nunca queda `""` en silencio.

### TDD (evidencia de red -> green)
Todos los archivos de test mandatorios por el tasks.md existen:
- `InMemoryStageRepository.test.ts` (T-05)
- `InMemorySchedulingRepository.test.ts` (T-06)
- `SendTaskToIClass.test.ts` (T-12)
- `MoveTaskToStage.test.ts` (T-13)
- `BackfillClosedServiceOrders.test.ts` (T-14)
- `IClassClosureScheduler.test.ts` (T-15)
- `getStageByCode.workflow.test.ts` (T-16, renombrado desde getStageByName)
- `IngestClosedServiceOrders.test.ts` (T-17) — fixtures con `code`
- `WorkflowUseCases.test.ts` (T-23)
- `workflows.routes.rbac.test.ts` (T-31) — 401/403/200/super_admin cubiertos
- `getStageByName.workflow.test.ts` conservado (escenarios `@deprecated` como referencia)

Cobertura de scenarios del spec: happy path + rename-safe + colision de slug +
unicidad por workflow + 401/403/super_admin cubiertos en integration test.
