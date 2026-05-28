# Tasks — task-bulk-send-to-iclass

STRICT TDD: test rojo → implementación → verde. `npm test` y `tsc --noEmit` verdes en cada gate. Aditivo (no rompe el endpoint single ni el front actual).

---

## Fase 1 — Helpers + Use-case (backend, TDD)

### 1.1 — Mapeo error→código compartido
- [x] 1.1 (TEST ROJO) `src/__tests__/application/domainErrorToCode.test.ts`: cada error de dominio → `{errorCode, reason?, missingFields?}`; error desconocido → null.
- [x] 1.2 Extraer `domainErrorToCode(err)` a `src/application/util/domainErrorToCode.ts` (util neutral, respeta DIP). Cubre MISSING_REQUIRED_FIELDS(+missingFields), ICLASS_NODE_NOT_FOUND, ICLASS_REJECTED(+reason), ICLASS_UNAVAILABLE, TASK_NOT_FOUND, STAGE_NOT_FOUND y cualquier DomainError vía `.code`.
- [x] 1.3 Refactor `errorHandler.ts` para usar `domainErrorToCode` (mismo contrato, sin cambiar comportamiento). Suite completa verde, sin regresiones.

### 1.2 — Concurrencia
- [x] 1.4 (TEST ROJO) `src/__tests__/application/mapWithConcurrency.test.ts`: procesa todos, respeta el límite (contador de concurrencia máxima ≤ limit), preserva orden de resultados.
- [x] 1.5 Implementar `mapWithConcurrency` en `src/application/util/mapWithConcurrency.ts` (worker-pool, puro).

### 1.3 — Use-case
- [x] 1.6 (TEST ROJO) `src/__tests__/application/BulkMoveTasksToStage.test.ts`:
  - todas OK → results todos `ok:true`, summary correcto.
  - fallo parcial (ids ok1/bad/ok2) → bad `ok:false` con errorCode, ok1/ok2 movidas, NO lanza.
  - cada error de dominio → su errorCode (+ reason/missingFields).
  - id inexistente → TASK_NOT_FOUND.
  - stage no-IClass → todas ok, sin IClass.
  - 12 ids → 12 results (todas procesadas).
  - orden de results == orden de ids.
- [x] 1.7 Implementar `BulkMoveTasksToStage.execute(ids, stageId)` (depende de `MoveTaskToStage` + concurrencia 5 + `domainErrorToCode`). Devuelve `{summary, results}`.
- [x] 1.8 (TEST VERDE) 1.6 pasa.

---

## Fase 2 — HTTP (backend, TDD)

- [x] 2.1 (TEST ROJO) en `scheduling.routes.test.ts`: `POST /api/scheduling/bulk/stage`:
  - body válido → 200 con `{summary, results}` (mezcla ok/fail).
  - body inválido (ids vacío / sin stageId) → 400 VALIDATION_ERROR, sin procesar.
  - sin auth → 401.
  - la ruta `/bulk/stage` resuelve al handler bulk (NO la traga `/:id`).
- [x] 2.2 Agregar `POST /bulk/stage` en `scheduling.routes.ts` con zod `{ ids: string[].min(1), stageId: string.min(1) }`, auth. **Montar ANTES de `/:id`** (AD-6).
- [x] 2.3 Wiring en `app.ts` (mínimo): instanciar `BulkMoveTasksToStage(moveTaskToStage)`, pasar al router.
- [x] 2.4 (TEST VERDE) 2.1 pasa. `npm test` + `tsc --noEmit` verdes.
  ✅ **DEPLOY GATE: endpoint bulk funcionando; front aún usa el loop viejo (sin romper).**

---

## Fase 3 — Frontend (repo ipnext-frontend, change `task-bulk-send-to-iclass-fe`)

> Va en el otro repo, como change `-fe`. Se lista acá para trazabilidad.

- [ ] 3.1 `api/scheduling.api.ts`: `bulkMoveToStage(ids, stageId)` → `POST /scheduling/bulk/stage`.
- [ ] 3.2 Hook `useBulkMoveTasksToStage` (TanStack mutation).
- [ ] 3.3 `BulkMoveResultModal` (TDD Vitest): resumen "X de N enviadas OK", lista de fallidas con motivo legible (reusar labels de `useIClassSendFeedback`/FIELD_LABELS), botones "Reintentar las fallidas" (onRetry con solo los ids fallidos) + "Cerrar".
- [ ] 3.4 `TasksTableView` BulkActionBar `onMoveStage`: reemplazar el loop secuencial por `bulkMoveToStage(ids, stageId)`; si hay `failed > 0` → abrir `BulkMoveResultModal` con los results; si todo OK → toast.
- [ ] 3.5 "Reintentar las fallidas" → re-llama el endpoint con solo los ids fallidos, actualiza el modal.
- [ ] 3.6 Tests (Vitest): bulk con fallos parciales abre el modal con la lista; reintento reprocesa solo las fallidas; todo OK → no modal.

---

## Verification Checklist
- [ ] V.1 `POST /bulk/stage` → 200 con `summary` + `results` por tarea, orden preservado.
- [ ] V.2 Fallo parcial: OK avanzan de stage, fallidas con `errorCode`; request sigue 200.
- [ ] V.3 Concurrencia ≤ 5; todas las tareas procesadas.
- [ ] V.4 Body inválido → 400; sin auth → 401.
- [ ] V.5 Stage no-IClass → todas ok sin llamar IClass.
- [ ] V.6 `domainErrorToCode` compartido por bulk y errorHandler (sin regresión en el single).
- [ ] V.7 Frontend: modal de resultado con fallidas + reintentar; todo OK → toast.
- [ ] V.8 `npm test` (BE y FE) verde, `tsc --noEmit` verde.
