# Capability Spec — scheduling-checklists

Status: proposed
RFC 2119 keywords: MUST, MUST NOT, SHOULD, SHOULD NOT, MAY.

## Scope

This spec covers checklist functionality for the Scheduling capability:
- Ordered items inside `TaskTemplate` (`TaskTemplateItem`).
- Per-task interactive checklist (`TaskChecklistItem`) embedded in `ScheduledTask`.
- Assigning a template's items into a task (cloning).

It does NOT cover the rest of `TaskTemplate` CRUD nor the broader `ScheduledTask` model (covered by the `scheduling` capability spec and `task-templates` surface).

## Entities

### `TaskTemplateItem`

| Field             | Type      | Constraints                                                       |
| ----------------- | --------- | ----------------------------------------------------------------- |
| `id`              | string    | uuid                                                              |
| `templateId`      | string    | FK → `TaskTemplate.id`, CASCADE on parent delete                  |
| `text`            | string    | 1..500 chars                                                      |
| `order`           | integer   | ≥ 0, unique per template (enforced by sort + renumber on reorder) |
| `createdAt`       | datetime  |                                                                   |
| `updatedAt`       | datetime  |                                                                   |

### `TaskChecklistItem`

| Field                | Type      | Constraints                                                                                      |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `id`                 | string    | uuid                                                                                             |
| `taskId`             | string    | FK → `ScheduledTask.id`, CASCADE on parent delete                                                |
| `text`               | string    | 1..500 chars                                                                                     |
| `done`               | boolean   | default `false`                                                                                  |
| `order`              | integer   | ≥ 0, unique per task                                                                             |
| `fromTemplateItemId` | string \| null | FK → `TaskTemplateItem.id`, SET NULL on parent delete; populated when item was cloned from a template |
| `createdAt`          | datetime  |                                                                                                  |
| `updatedAt`          | datetime  |                                                                                                  |

## Requirements

### REQ-TPL-ITEM-1 — Read template with items

**Given** a `TaskTemplate` with id `T`
**When** a GET request is made to `/api/scheduling/task-templates/T`
**Then** the response body MUST include an `items` array sorted ASC by `order`, and each item MUST contain `id`, `text`, `order`.

### REQ-TPL-ITEM-2 — Replace template items (full-set)

**Given** an authenticated request
**When** a PUT request is made to `/api/scheduling/task-templates/:id/items` with body `{ items: [{ text }] }` (an ordered array)
**Then** the server MUST delete the existing items for that template and create the new ones, assigning `order` from the input array index (0-based), and return the resulting items array sorted by `order`.

### REQ-TPL-ITEM-3 — Template item validation

**When** any item in the PUT body has empty `text` or `text.length > 500`
**Then** the server MUST respond `400 VALIDATION_ERROR` and MUST NOT mutate state.

### REQ-TPL-ITEM-4 — Template not found

**When** PUT/GET targets a non-existent template id
**Then** the server MUST respond `404 TEMPLATE_NOT_FOUND`.

### REQ-CHECKLIST-1 — Read checklist with task

**Given** a `ScheduledTask` with id `K`
**When** a GET request is made to `/api/scheduling/K`
**Then** the response MUST include a `checklist` array (possibly empty) sorted ASC by `order`, each entry containing `id`, `text`, `done`, `order`, `fromTemplateItemId`.

### REQ-CHECKLIST-2 — Add ad-hoc item

**Given** task `K`
**When** POST `/api/scheduling/K/checklist` is sent with `{ text }`
**Then** the server MUST append a new item with `order = (max existing order) + 1` (0 if empty), `done = false`, `fromTemplateItemId = null`, and return the created item.

### REQ-CHECKLIST-3 — Toggle done

**Given** checklist item `I` belonging to task `K`
**When** PATCH `/api/scheduling/K/checklist/I/toggle` is sent (no body)
**Then** the server MUST flip `done` and return the updated item.

### REQ-CHECKLIST-4 — Update text

**When** PATCH `/api/scheduling/K/checklist/I` is sent with `{ text }`
**Then** the server MUST update `text` (preserving `done` and `order`) and return the updated item.

### REQ-CHECKLIST-5 — Remove item

**When** DELETE `/api/scheduling/K/checklist/I` is sent
**Then** the server MUST remove the item and respond `204`. Remaining items keep their `order` values (no renumbering); reads MUST still sort by `order` and the gaps SHOULD NOT be observable to the user.

### REQ-CHECKLIST-6 — Reorder

**When** PUT `/api/scheduling/K/checklist/order` is sent with `{ orderedIds: string[] }`
**Then** the server MUST verify every id in `orderedIds` belongs to task `K`, MUST renumber the items by array index (0-based), and MUST return the resulting checklist sorted by `order`. If any id is foreign or missing, the server MUST respond `400 VALIDATION_ERROR` and MUST NOT mutate state.

### REQ-CHECKLIST-7 — Ad-hoc item, item not found

**When** PATCH/DELETE targets `(K, I)` where item `I` does not exist on task `K`
**Then** the server MUST respond `404 CHECKLIST_ITEM_NOT_FOUND`.

### REQ-CHECKLIST-8 — Clear checklist

**When** DELETE `/api/scheduling/K/checklist` is sent
**Then** the server MUST delete every checklist item for task `K` and respond `204`.

### REQ-ASSIGN-TPL-1 — Assign template clones items

**Given** task `K` and template `T` with items `[A, B, C]` in order
**When** POST `/api/scheduling/K/checklist/assign-template` is sent with `{ templateId: T }`
**Then** the server MUST:
1. Delete existing checklist items for task `K` (REPLACE semantics).
2. Create new checklist items copying `text` and `order` from each template item, setting `done=false` and `fromTemplateItemId=<source item id>`.
3. Return the new checklist array sorted by `order`.

### REQ-ASSIGN-TPL-2 — Assign template, template not found

**When** the referenced `templateId` does not exist
**Then** the server MUST respond `404 TEMPLATE_NOT_FOUND` and MUST NOT mutate the task.

### REQ-ASSIGN-TPL-3 — Assign template, empty template

**When** the template has no items
**Then** the server MUST still delete the existing checklist (per REPLACE semantics) and return an empty `checklist` array.

### REQ-ASSIGN-TPL-4 — Template item deleted later

**Given** a checklist item with `fromTemplateItemId = X`
**When** the original `TaskTemplateItem` X is later deleted (e.g. via PUT replace-set)
**Then** the checklist item MUST persist with `fromTemplateItemId = null`. No checklist data MUST be lost.

### REQ-AUTH-1 — Authentication required

**When** any checklist/template-items endpoint is called without a valid `auth_token` cookie
**Then** the server MUST respond `401`.

### REQ-VAL-1 — ID validation

All path/body IDs MUST be validated with `z.string().min(1)`. The server MUST NOT use `z.string().uuid()` (per change-1 lesson).

### REQ-VAL-2 — Text length

`text` fields MUST be validated as `z.string().min(1).max(500)`.

### REQ-VAL-3 — `orderedIds` shape

`orderedIds` MUST be `z.array(z.string().min(1)).min(0)`.

### REQ-OPTIMISTIC-1 — Optimistic toggle in UI

**Given** the user clicks a checkbox in `SchedulingTaskDetailPage`
**Then** the UI MUST flip the checkbox immediately (before the server responds).
**When** the server responds with 2xx, the UI MUST keep the new state.
**When** the server responds 5xx OR the request errors at network layer, the UI MUST roll back to the prior state and surface a non-blocking error toast.
**When** the server responds 4xx, the UI MUST refetch the task to reconcile and surface a toast.

### REQ-OPTIMISTIC-2 — Add/remove/reorder are NOT optimistic in v1

These mutations MUST wait for the server response before updating UI. (Acceptable v1 tradeoff — toggle is the hot path.)

### REQ-A11Y-1 — Checkbox semantics

Each checklist item MUST render as a `<label>` wrapping a real `<input type="checkbox">`. Toggling via keyboard (Space) MUST work without custom handlers.

### REQ-A11Y-2 — Keyboard reorder

Drag-reorder MUST be operable via keyboard. The drag library MUST expose keyboard sensors so users can grab an item, move it with arrow keys, and drop with Space/Enter.

### REQ-A11Y-3 — Live region for toggle

The container of the checklist SHOULD use `aria-live="polite"` so screen readers announce changes.

### REQ-A11Y-4 — Buttons not divs

"Cargar lista", "Limpiar lista", "Añadir elemento", "Eliminar" MUST be real `<button>` elements with accessible names.

## Out of Scope

- Per-item assignee, due date, attachments.
- Bulk paste markdown bullets.
- Real-time sync between concurrent editors.
- Items inside `Project` (this change is task-scoped only).
