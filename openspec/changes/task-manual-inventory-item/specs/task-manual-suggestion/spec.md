# task-manual-suggestion Specification

## Purpose

Operators can create a `TaskInventorySuggestion` with `source='MANUAL'` via a POST endpoint and a FE inline form. The manual suggestion enters the same confirm/discard pipeline as OCR and IClass suggestions.

## Requirements

### Requirement: Create Manual Suggestion via API

`POST /api/scheduling/:taskId/inventory/suggestions` MUST create a `TaskInventorySuggestion` with `source='MANUAL'`, `status='pending'` for the given task. Requires `inventory.write` permission.

Input:
- `kind='DEVICE'`: MUST include a catalog `deviceType` plus at least one of `serialNumber` or `mac`.
- `kind='MATERIAL'`: MUST include a non-empty `materialDesc`.

Validation MUST be fail-fast (applied at creation, before insert). Incomplete input MUST return `422 { code: "SUGGESTION_INCOMPLETE" }`. Task not found MUST return `404`.

A MANUAL suggestion with the same `serialNumber`/`mac` as an existing OCR suggestion MUST coexist (no upsert clobber). The `InventorySuggestionRepository` MUST expose a dedicated `create()` method used by this use case.

#### Scenario: DEVICE suggestion — serial number only

- GIVEN a task exists and the caller has `inventory.write`
- WHEN `POST .../suggestions` with `{ kind: 'DEVICE', deviceType: 'ROUTER', serialNumber: 'SN-001' }`
- THEN `201` response, suggestion persisted with `source='MANUAL'`, `status='pending'`

#### Scenario: DEVICE suggestion — MAC only

- GIVEN a task exists and the caller has `inventory.write`
- WHEN `POST .../suggestions` with `{ kind: 'DEVICE', deviceType: 'ONU', mac: 'AA:BB:CC:DD:EE:FF' }`
- THEN `201` response, suggestion persisted with `source='MANUAL'`, `status='pending'`

#### Scenario: MATERIAL suggestion — happy path

- GIVEN a task exists and the caller has `inventory.write`
- WHEN `POST .../suggestions` with `{ kind: 'MATERIAL', materialDesc: 'Cable coaxial 10m', quantity: 2, unit: 'm' }`
- THEN `201` response, suggestion persisted with `source='MANUAL'`, `status='pending'`

#### Scenario: DEVICE incomplete — no SN or MAC

- GIVEN a task exists and the caller has `inventory.write`
- WHEN `POST .../suggestions` with `{ kind: 'DEVICE', deviceType: 'ANTENA' }` (no serialNumber, no mac)
- THEN `422 { code: "SUGGESTION_INCOMPLETE" }`
- AND no suggestion is inserted

#### Scenario: MATERIAL incomplete — empty description

- GIVEN a task exists and the caller has `inventory.write`
- WHEN `POST .../suggestions` with `{ kind: 'MATERIAL', materialDesc: '' }`
- THEN `422 { code: "SUGGESTION_INCOMPLETE" }`
- AND no suggestion is inserted

#### Scenario: Forbidden — missing permission

- GIVEN the caller does NOT have `inventory.write`
- WHEN `POST .../suggestions` with a valid body
- THEN `403`

#### Scenario: Task not found

- GIVEN no task exists with the provided `taskId`
- WHEN `POST .../suggestions` with a valid body
- THEN `404`

#### Scenario: MANUAL does not clobber OCR suggestion

- GIVEN an OCR suggestion exists for task T1 with `serialNumber='SN-X'`, `mac='AA:BB'`
- WHEN `POST .../suggestions` with `{ kind: 'DEVICE', deviceType: 'ONU', serialNumber: 'SN-X', mac: 'AA:BB' }`
- THEN `201`; both the OCR suggestion and the new MANUAL suggestion coexist as separate rows

---

### Requirement: FE "Agregar ítem" Button and Inline Form

The `TaskInventorySuggestions` panel MUST show an "Agregar ítem" button in BOTH the empty state and the non-empty (list) state, gated by `inventory.write`. Clicking it opens an inline form (no modal).

The form MUST:
- Offer a `kind` selector: DEVICE / MATERIAL.
- For DEVICE: show a `deviceType` dropdown (catalog values) and SN / MAC inputs.
- For MATERIAL: show `materialDesc`, `quantity`, and `unit` inputs.
- Mirror the `#18` `incomplete` validation: show `incompleteHint` if user attempts submit with missing required fields.
- Call `useCreateManualSuggestion(taskId)` on valid submit; close form on success.

`SuggestionCard` MUST display `'Manual'` as the `sourceLabel` when `suggestion.source === 'MANUAL'`.

#### Scenario: Button visible in empty state

- GIVEN the task has no suggestions AND the user has `inventory.write`
- WHEN `TaskInventorySuggestions` renders
- THEN "Agregar ítem" button is visible

#### Scenario: Button visible in non-empty state

- GIVEN the task has at least one pending suggestion AND the user has `inventory.write`
- WHEN `TaskInventorySuggestions` renders
- THEN "Agregar ítem" button is visible alongside the suggestion list

#### Scenario: Button hidden without permission

- GIVEN the user does NOT have `inventory.write`
- WHEN `TaskInventorySuggestions` renders (empty or non-empty)
- THEN "Agregar ítem" button is NOT rendered

#### Scenario: Form — incompleteHint on DEVICE submit without SN/MAC

- GIVEN the inline form is open with `kind='DEVICE'` and no SN/MAC filled
- WHEN the user submits
- THEN `incompleteHint` is displayed; no API call is made

#### Scenario: Form — successful DEVICE submission

- GIVEN the inline form is open with `kind='DEVICE'`, `deviceType='ONU'`, `serialNumber='SN-001'`
- WHEN the user submits
- THEN `useCreateManualSuggestion` is called; form closes; suggestion appears in the pending list

#### Scenario: MANUAL sourceLabel on SuggestionCard

- GIVEN a suggestion with `source='MANUAL'`
- WHEN `SuggestionCard` renders
- THEN the source badge displays `'Manual'`
