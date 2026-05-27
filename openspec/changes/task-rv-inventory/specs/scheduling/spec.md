# Spec: task-rv-inventory — scheduling capability delta

## Context

Extends the `scheduling` capability with a boolean flag `reviewedByInventory` on `ScheduledTask`. The flag drives the "RV" column (Revisado por Inventario) shown in the task list UI.

## Requirements

### REQ-RV-1: Schema field
`ScheduledTask` DB row MUST have `reviewedByInventory Boolean @default(false)`.  
New rows default to `false`. Existing rows are backfilled to `false` via migration default.

### REQ-RV-2: Domain entity field
`ScheduledTask` TypeScript interface MUST expose `reviewedByInventory: boolean`.  
The field MUST be present on every task returned from the API.

### REQ-RV-3: Port method
`SchedulingRepository` MUST expose:
```ts
setInventoryReview(taskId: string, reviewed: boolean): Promise<ScheduledTask | null>
```
Returns `null` when the task is not found.

### REQ-RV-4: Use case
`SetTaskInventoryReview` MUST:
- Accept `(taskId: string, reviewed: boolean)`.
- Delegate to `repo.setInventoryReview`.
- Return the updated `ScheduledTask`.
- Throw `TaskNotFoundError` when the task does not exist.

### REQ-RV-5: HTTP endpoint
```
PATCH /api/scheduling/:id/inventory-review
Body: { "reviewed": true | false }
Auth: required (same cookie auth as all other scheduling endpoints)
```
- 200 + updated task DTO on success.
- 400 + `VALIDATION_ERROR` if body is invalid.
- 404 + `TASK_NOT_FOUND` if task does not exist.

### REQ-RV-6: Existing task responses
All existing endpoints that return `ScheduledTask` (GET list, GET single, POST, PUT, PATCH stage) MUST include `reviewedByInventory` in the response. No change needed beyond adding the field to the entity + mapper — existing mappers pass it through.

## Scenarios

### SCEN-RV-1: Set flag to true
Given task T exists with `reviewedByInventory = false`  
When `PATCH /api/scheduling/T/inventory-review` with `{ "reviewed": true }`  
Then response is 200 with `reviewedByInventory: true`

### SCEN-RV-2: Unset flag to false
Given task T exists with `reviewedByInventory = true`  
When `PATCH /api/scheduling/T/inventory-review` with `{ "reviewed": false }`  
Then response is 200 with `reviewedByInventory: false`

### SCEN-RV-3: Task not found
Given no task with id "nonexistent"  
When `PATCH /api/scheduling/nonexistent/inventory-review` with `{ "reviewed": true }`  
Then response is 404 with `code: "TASK_NOT_FOUND"`

### SCEN-RV-4: Invalid body
When `PATCH /api/scheduling/:id/inventory-review` with `{ "reviewed": "yes" }`  
Then response is 400 with `code: "VALIDATION_ERROR"`

### SCEN-RV-5: Default value
When a new task is created  
Then `reviewedByInventory` is `false` in the response

### SCEN-RV-6: Persistence through update
Given task T has `reviewedByInventory = true`  
When `PUT /api/scheduling/T` with any other field change  
Then `reviewedByInventory` remains `true` (not reset)
