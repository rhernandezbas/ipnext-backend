# Tech Material Consumption Specification (Wave 4)

## Purpose

El técnico declara qué materiales consumió en una tarea, anclado a SU propio stock y SU propia tarea. Reusa `RecordMaterialConsumption.ts` + `StageMaterialDeduction.ts` (staging de deducción, ya construido para el canal operador/inventory-review) — cero lógica de negocio nueva, solo la superficie de escritura para el rol técnico (verificado: `RecordMaterialConsumption.ts` ya acepta `recordedByUserId` opcional y ya invoca el staging hook si está inyectado).

## Requirements

### Requirement: Technician sees only their own stock

El sistema DEBE (MUST) resolver `GET /api/tech/stock` con `GetTechnicianStock.execute(req.technicianId)` (`GetTechnicianStock.ts:40`) — nunca aceptar un `technicianId` de query/param.

#### Scenario: A technician with no stock location gets an empty shape, not an error
- GIVEN un técnico sin ubicación `TECNICO` resuelta todavía (`findByTypeAndTechnician` devuelve `null`)
- WHEN hace `GET /api/tech/stock`
- THEN recibe `200 { technicianId, locationId: null, assets: [], materials: [] }` (comportamiento YA verificado en `GetTechnicianStock.ts:42-43`)

### Requirement: Consumption is recorded against the technician's own assigned task

El sistema DEBE (MUST) rechazar `POST /api/tech/tasks/:id/materials` con `404 TASK_NOT_FOUND` si la tarea no existe O `assigneeId !== req.technicianId` (mismo criterio anti-IDOR del resto de `/api/tech/*`).

El sistema DEBE (MUST) setear `recordedByUserId = req.technicianId` SIEMPRE — nunca aceptarlo del body (`RecordMaterialConsumptionInput.recordedByUserId` existe y es opcional, `RecordMaterialConsumption.ts:15`, pero para esta superficie el valor viene ÚNICAMENTE del token).

#### Scenario: Recording consumption on a foreign task is 404
- GIVEN la tarea `t-2` asignada a `tech-B`
- WHEN `tech-A` hace `POST /api/tech/tasks/t-2/materials`
- THEN `404 { code: 'TASK_NOT_FOUND' }`

#### Scenario: Valid consumption is recorded and staged for deduction
- GIVEN `tech-A` tiene asignada `t-1` (`generalStatus='open'`) y el material `M1` existe en el catálogo
- WHEN `tech-A` hace `POST /api/tech/tasks/t-1/materials { materialCatalogId: 'M1', quantity: 2 }`
- THEN se crea un `TaskMaterialConsumption` con `recordedByUserId='tech-A'`
- AND se dispara `StageMaterialDeduction` con `technicianId=t-1.assigneeId` (idéntico al flujo operador existente, `RecordMaterialConsumption.ts:54-67`)

### Requirement: Invalid quantity and unknown material are rejected before writing

El sistema DEBE (MUST) rechazar `quantity <= 0` (`InvalidQuantityError`, existente) y `materialCatalogId` inexistente (`MaterialNotFoundError`, existente) ANTES de crear ninguna fila.

#### Scenario: Zero quantity is rejected
- GIVEN `tech-A` envía `{ materialCatalogId: 'M1', quantity: 0 }`
- WHEN se procesa
- THEN `400 { code: 'INVALID_QUANTITY' }`, ninguna fila se crea

#### Scenario: Unknown material is rejected
- GIVEN `materialCatalogId='NO-EXISTE'` no está en el catálogo
- WHEN se procesa
- THEN `404 { code: 'MATERIAL_NOT_FOUND' }`

## HTTP Contract

### GET /api/tech/stock
Response `200`: `TechnicianStockDTO` (shape existente, `application/dto/TechnicianStockDto.ts`, verificado vía `GetTechnicianStock.ts`):
```ts
{
  technicianId: string;
  locationId: string | null;
  assets: Array<{ id: string; serialNumber: string | null; mac: string | null; deviceTypeId: string; deviceTypeName: string | null; deviceTypeLabel: string | null; status: 'available'; sourceTaskId: string | null }>;
  materials: Array<{ id: string; materialCatalogId: string; name: string | null; label: string | null; unit: string | null; qty: number }>;
}
```

### POST /api/tech/tasks/:id/materials
Body: `{ materialCatalogId: string, quantity: number, unit?: string | null, notes?: string | null }`
Response `201`: `MaterialConsumptionDto` (shape existente, `application/dto/MaterialConsumptionDto.ts`, extiende `TaskMaterialConsumption`):
```ts
{
  id: string; taskId: string; materialCatalogId: string; materialName: string;
  quantity: number; unit: string | null; notes: string | null;
  recordedByUserId: string | null; recordedByUserName: string | null;
  deductedAt: string | null; deductedMovementId: string | null;
  createdAt: string; updatedAt: string;
}
```
Errors:
| Status | code |
|---|---|
| 400 | `VALIDATION_ERROR` (falta `materialCatalogId` o `quantity`) |
| 400 | `INVALID_QUANTITY` |
| 404 | `TASK_NOT_FOUND` |
| 404 | `MATERIAL_NOT_FOUND` |

### GET /api/tech/tasks/:id/materials
Reusa `TaskMaterialConsumptionRepository.listByTask` (port existente, `TaskMaterialConsumptionRepository.ts:4`).
Response `200`: `{ data: MaterialConsumptionDto[] }`. Errors: `404 TASK_NOT_FOUND` (tarea ajena o inexistente).

**NO VERIFICADO CONTRA CÓDIGO:** el staging (`StageMaterialDeduction`) es "best-effort" — una falla ahí NO aborta la consumición (`RecordMaterialConsumption.ts:52-67`, `try/catch` mudo salvo log). Este spec hereda ese comportamiento tal cual; no se propone endurecerlo para la superficie técnico.

## Aditivo, solo-crece
Superficie nueva; los DTOs reusados (`TechnicianStockDTO`, `MaterialConsumptionDto`) ya son estables y consumidos por el canal operador — no se les agrega ni quita ningún campo en esta wave.
