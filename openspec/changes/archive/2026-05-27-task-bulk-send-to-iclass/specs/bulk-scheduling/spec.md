# Spec: Bulk Scheduling — mover N tareas a stage

**Capability**: `bulk-scheduling` (NEW)
**Change**: `task-bulk-send-to-iclass`
**Endpoint**: `POST /api/scheduling/bulk/stage` (auth). Montado ANTES del catch-all `/:id`.

---

## Added Requirements

### REQ-BULK-1: Contrato del endpoint

`POST /api/scheduling/bulk/stage` body `{ ids: string[], stageId: string }`.

#### Scenario: Body válido devuelve 200 con resultados por tarea
**Given** un request autenticado con `{ ids: ["t1","t2"], stageId: "<stage>" }`
**When** se procesa
**Then** MUST responder **200** con:
```json
{
  "summary": { "total": 2, "ok": <n>, "failed": <m> },
  "results": [
    { "taskId": "t1", "ok": true },
    { "taskId": "t2", "ok": false, "errorCode": "MISSING_REQUIRED_FIELDS", "missingFields": ["phone"] }
  ]
}
```
**And** `results` MUST tener una entrada por cada id de entrada (mismo orden)
**And** `summary.ok + summary.failed` MUST igualar `summary.total`.

#### Scenario: Body inválido → 400
**Given** un body con `ids: []` (vacío) o sin `stageId`
**When** se procesa
**Then** MUST responder **400** con `{ code: "VALIDATION_ERROR" }`
**And** NO MUST procesar ninguna tarea.

#### Scenario: Sin auth → 401
**Given** un request sin token
**Then** MUST responder **401**.

### REQ-BULK-2: Procesamiento por tarea (reusa MoveTaskToStage)

Cada id se procesa con `MoveTaskToStage.execute(id, stageId)` (que delega en `SendTaskToIClass` si el stage es "Enviar a IClass"). El bulk NO duplica esa lógica.

#### Scenario: Tarea OK
**Given** una tarea que se mueve sin error
**Then** su resultado MUST ser `{ taskId, ok: true }`.

#### Scenario: Un fallo NO aborta el resto
**Given** `ids: ["ok1", "bad", "ok2"]` donde "bad" falla
**When** se procesa
**Then** "ok1" y "ok2" MUST quedar movidas (`ok: true`)
**And** "bad" MUST aparecer `ok: false` con su `errorCode`
**And** el endpoint MUST responder 200 (no 4xx/5xx por el fallo parcial).

### REQ-BULK-3: Mapeo de errores por tarea

Cada error de dominio MUST mapearse a un resultado (NO propagar como error HTTP del request):

| Error de dominio | `errorCode` | campos extra |
|------------------|-------------|--------------|
| `MissingRequiredFieldsError` | `MISSING_REQUIRED_FIELDS` | `missingFields[]` |
| `IClassNodeNotFoundError` | `ICLASS_NODE_NOT_FOUND` | — |
| `IClassRejectedError` | `ICLASS_REJECTED` | `reason` |
| `IClassUnavailableError` | `ICLASS_UNAVAILABLE` | — |
| `TaskNotFoundError` | `TASK_NOT_FOUND` | — |
| `StageNotFoundError` | `STAGE_NOT_FOUND` | — |

#### Scenario: IClass rechaza una tarea
**Given** una tarea cuyo envío a IClass lanza `IClassRejectedError("ICLERR_xxx: ...")`
**Then** su resultado MUST ser `{ taskId, ok: false, errorCode: "ICLASS_REJECTED", reason: "ICLERR_xxx: ..." }`.

#### Scenario: Tarea inexistente
**Given** un id que no existe
**Then** su resultado MUST ser `{ taskId, ok: false, errorCode: "TASK_NOT_FOUND" }`.

### REQ-BULK-4: Concurrencia acotada

El procesamiento MUST correr con **concurrencia máxima de 5** tareas en simultáneo (lotes / pool), NO un `Promise.all` masivo de N. (Evita saturar IClass.) Todas las tareas MUST procesarse aunque haya fallos (`Promise.allSettled`-style).

#### Scenario: Todas las tareas se procesan
**Given** `ids` con 12 tareas
**When** se procesa
**Then** `results` MUST tener 12 entradas (todas procesadas, en lotes de a 5).

### REQ-BULK-5: Stage que NO es IClass

#### Scenario: Mover masivo a un stage normal
**Given** `ids` válidos y un `stageId` que NO es "Enviar a IClass"
**When** se procesa
**Then** todas MUST moverse (`ok: true`) sin llamar a IClass.

---

## Appendix: Códigos por-tarea (NO son códigos HTTP del request)

El request siempre responde 200 (salvo body inválido → 400, o sin auth → 401). Los `errorCode` viven dentro de cada `results[i]`.
