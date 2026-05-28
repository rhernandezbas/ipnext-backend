# Proposal: Bulk mover tareas a stage (con resultado parcial)

## Intent

Hoy la acción masiva "Mover estado" hace un **loop secuencial en el front y traga los errores en silencio**: si movés 10 tareas a "Enviar a IClass" y 3 fallan (falta teléfono, ciudad sin nodo, etc.), no te enterás. Queremos un bulk **robusto**: el backend procesa las N tareas con **concurrencia controlada** y devuelve un **resultado por tarea**; el front muestra un **modal al final** con las que fallaron y su motivo, y permite **reintentar solo las fallidas**.

## Scope

### In Scope (backend — este change)
- Use-case `BulkMoveTasksToStage` (`ids[]`, `stageId`) que reusa `MoveTaskToStage`/`SendTaskToIClass` por tarea (sin duplicar lógica), con `Promise.allSettled` + concurrencia acotada.
- Endpoint `POST /api/scheduling/bulk/stage` `{ ids, stageId }` (auth) → **200** con `{ summary{total,ok,failed}, results: [{taskId, ok, errorCode?, reason?, missingFields?}] }`. Devuelve 200 aunque algunas fallen (no es all-or-nothing; los fallos van en el body).
- Mapear cada error de dominio a `{errorCode, reason?, missingFields?}` (MISSING_REQUIRED_FIELDS / ICLASS_NODE_NOT_FOUND / ICLASS_REJECTED / ICLASS_UNAVAILABLE / TASK_NOT_FOUND / STAGE_NOT_FOUND).

### Out of Scope
- Frontend (va en el change `task-bulk-send-to-iclass-fe`): reemplazar el loop por el endpoint bulk, modal de resultado + reintentar fallidas.
- Bulk close / bulk delete (solo cambio de stage).
- El endpoint single `PATCH /:id/stage` queda intacto.

## Capabilities
### New
- `bulk-scheduling`: mover N tareas a un stage con resultado parcial por tarea.
### Modified
- `scheduling`: la acción masiva de stage ahora reporta fallos por tarea (antes los tragaba).

## Approach
`BulkMoveTasksToStage.execute(ids, stageId)` corre las tareas en lotes de concurrencia acotada (ej. 5) con `Promise.allSettled`; cada una usa `MoveTaskToStage.execute(id, stageId)` (que ya delega en IClass si corresponde). Captura el resultado/excepción de cada una y arma `{taskId, ok, errorCode?, reason?, missingFields?}`. El endpoint devuelve siempre 200 con el agregado. Para stages que NO son IClass, el bulk simplemente mueve (todos `ok`). Idempotencia y validaciones las hereda de `SendTaskToIClass`.

## Affected Areas
| Area | Impact |
|------|--------|
| `src/application/use-cases/BulkMoveTasksToStage.ts` | New |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modified — `POST /bulk/stage` (montar ANTES del catch-all `/:id`) |
| `src/infrastructure/http/app.ts` | Modified — wiring (mínimo) |

## Risks
| Risk | Mitigation |
|------|------------|
| Muchas tareas → rate limit / saturar IClass | concurrencia acotada (lotes de ~5), no `Promise.all` masivo |
| Estado parcial (algunas movidas, otras no) | es el comportamiento buscado; se reporta claro por tarea + reintento |
| Confundir fallo total con parcial | 200 + body con `failed`; 4xx solo si el request es inválido (body malformado) |
| Catch-all `/:id` se traga `/bulk` | montar la ruta bulk ANTES (gotcha conocido del repo) |

## Rollback Plan
Revertir los commits. El endpoint single y el bulk-loop actual del front no se rompen hasta que el front migre. Sin estado persistido nuevo.

## Success Criteria
- [ ] `POST /bulk/stage` con N ids → 200 con `results` por tarea y `summary`.
- [ ] Mezcla de éxitos y fallos → cada fallo trae `errorCode` (+ `reason`/`missingFields`); los OK avanzan de stage.
- [ ] Concurrencia acotada (no dispara N llamadas simultáneas a IClass).
- [ ] Stage no-IClass → mueve todas, todas `ok`.
- [ ] Tests (TDD) con in-memory; `tsc` limpio.
