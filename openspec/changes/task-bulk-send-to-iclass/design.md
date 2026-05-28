# Design: task-bulk-send-to-iclass

## Contexto
Bulk-mover N tareas a un stage con resultado parcial por tarea. El destino crítico es "Enviar a IClass" (cada tarea puede fallar distinto). Backend procesa; front muestra modal. Hexagonal, TDD.

## Architecture Decisions

### AD-1: `BulkMoveTasksToStage` reusa `MoveTaskToStage` (no duplica lógica)
El use-case bulk recibe `MoveTaskToStage` (no los repos ni IClass directamente) y lo ejecuta por cada id. Toda la lógica (flag, validación, nodo, idempotencia, alta IClass) ya vive ahí. El bulk solo orquesta: concurrencia + captura de resultado/error por tarea.

### AD-2: Concurrencia acotada (pool de 5)
NO `Promise.all` masivo (saturaría IClass). Un limitador simple: procesar en lotes de 5 con `Promise.allSettled`, o un pool. Preferir un helper `mapWithConcurrency(items, limit, fn)` testeable. Default limit 5 (configurable por constante).

### AD-3: Siempre 200 (resultado parcial); 4xx solo por request inválido
Mover varias tareas NO es atómico: unas pueden ir y otras no. El endpoint responde **200** con `{summary, results[]}`. Solo el body malformado (zod) da 400, y sin auth 401. Los errores por-tarea viven en `results[i].errorCode`.

### AD-4: Mapeo error→resultado COMPARTIDO con el error-handler HTTP
Para no divergir, extraer un helper `domainErrorToCode(err): { errorCode, reason?, missingFields? } | null` que use TANTO el bulk (para armar `results[i]`) COMO el `errorHandler.ts` (que hoy tiene el statusMap + extracción de missingFields/reason). Así el contrato de códigos queda en un solo lugar. Si la extracción ya está acoplada en errorHandler, factorizarla a un módulo de dominio/util reutilizable.

### AD-5: Orden y forma del resultado
`results` preserva el orden de `ids` de entrada (una entrada por id). `summary = {total, ok, failed}`. Cada entrada: `{taskId, ok}` y si `ok:false` → `errorCode` (+ `reason?`/`missingFields?`).

### AD-6: Routing — montar `/bulk/stage` ANTES de `/:id`
Gotcha conocido del repo: el catch-all `/:id` se traga las sub-rutas. La ruta `POST /bulk/stage` MUST montarse antes del `router.patch('/:id/stage')` y del `/:id`.

## Sequence
```
POST /api/scheduling/bulk/stage { ids, stageId }
  → zod valida (ids no vacío, stageId) → 400 si falla
  → BulkMoveTasksToStage.execute(ids, stageId)
       mapWithConcurrency(ids, 5, async id => {
         try   { await moveTaskToStage.execute(id, stageId); return {taskId:id, ok:true} }
         catch (e) { return { taskId:id, ok:false, ...domainErrorToCode(e) } }
       })
  → summary = count(ok), count(failed)
  → 200 { summary, results }
```

## Testing strategy (TDD)
- `BulkMoveTasksToStage` con in-memory (scheduling repo, feature flag, InMemoryIClassClient): casos OK, fallo parcial, mapeo de cada error, stage no-IClass, 12 tareas (todas procesadas). Inyectar un `MoveTaskToStage` real armado con in-memory, o un doble que falle para ids dados.
- `domainErrorToCode` testeado en aislamiento (cada error → su code).
- Route con supertest: 200 con results, 400 body inválido, 401 sin auth, y que `/bulk/stage` no choque con `/:id`.
- `mapWithConcurrency`: test de que respeta el límite (ej. instrumentar un contador de concurrencia máxima observada) y procesa todos.

## Rollback
Revertir commits. El endpoint single y el loop actual del front siguen funcionando hasta que el front migre. Sin schema nuevo.

## Riesgos / notas
- No abrir 1 conexión por tarea sin límite → el pool de 5 lo cubre.
- `MoveTaskToStage` resuelve el stage por id una vez por tarea; aceptable. Si fuese cuello de botella, cachear el stage lookup (out of scope ahora).
- Frontend (change `task-bulk-send-to-iclass-fe`): `useBulkMoveTasksToStage` → endpoint; `BulkMoveResultModal` (resumen + lista fallidas con motivo legible + "Reintentar fallidas" que reprocesa solo esos ids). Reusar los labels/mapeo de `useIClassSendFeedback`.
