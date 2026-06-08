# Delta for service-inventory

## MODIFIED Requirements

### Requirement: confirm-inventory-suggestion

`POST /api/scheduling/:taskId/inventory/suggestions/:suggestionId/confirm`

- Creates a `ContractInstalledItem` (or `TaskMaterialConsumption` for MATERIAL kind) associated with the task's service.
- The `source` field on the created item MUST be the suggestion's `source` passed through verbatim: `'OCR'` → `'OCR'`, `'ICLASS_MATERIAL'` → `'ICLASS'`, `'MANUAL'` → `'MANUAL'`.
- Marks the suggestion `confirmed` and saves `confirmedItemId`.
- `addedByUserId` comes from the authenticated user; `confirmedAt` is set to now.

(Previously: source mapping was `suggestion.source === 'OCR' ? 'OCR' : 'ICLASS'`, which incorrectly labelled `MANUAL` suggestions as `ICLASS` on the contract item.)

#### Scenario: SCEN-CF-1 — confirm DEVICE suggestion → installed item

- GIVEN a pending DEVICE suggestion exists for a task with a valid `serviceId`
- WHEN `POST .../confirm` is called
- THEN a `ContractInstalledItem` is created with the suggestion's `serialNumber`, `mac`, and `source` verbatim
- AND the suggestion status becomes `confirmed`

#### Scenario: SCEN-CF-2 — confirm two ROUTER suggestions → two items

- GIVEN two pending DEVICE suggestions of type ROUTER exist for the same task
- WHEN both are confirmed sequentially
- THEN two separate `ContractInstalledItem` rows exist (one per suggestion)

#### Scenario: SCEN-CF-3 — task without serviceId → 409

- GIVEN a pending suggestion exists for a task with no `serviceId`
- WHEN `POST .../confirm` is called
- THEN `409 { code: "TASK_HAS_NO_SERVICE" }`

#### Scenario: SCEN-CF-4 — already confirmed → 409

- GIVEN a suggestion is already `confirmed`
- WHEN `POST .../confirm` is called again
- THEN `409 { code: "SUGGESTION_ALREADY_CONFIRMED" }`

#### Scenario: SCEN-CF-5 — MANUAL suggestion confirmed → source preserved

- GIVEN a pending suggestion with `source='MANUAL'` exists
- WHEN `POST .../confirm` is called
- THEN the created `ContractInstalledItem` has `source='MANUAL'`

#### Scenario: SCEN-CF-6 — OCR suggestion confirmed → source OCR

- GIVEN a pending suggestion with `source='OCR'` exists
- WHEN `POST .../confirm` is called
- THEN the created `ContractInstalledItem` has `source='OCR'`

#### Scenario: SCEN-CF-7 — ICLASS_MATERIAL suggestion confirmed → source ICLASS

- GIVEN a pending suggestion with `source='ICLASS_MATERIAL'` exists
- WHEN `POST .../confirm` is called
- THEN the created `ContractInstalledItem` has `source='ICLASS'`

## ADDED Requirements

### Requirement: suggestion-source-enum

The `TaskInventorySuggestion.source` field MUST accept `'MANUAL'` as a valid value in addition to `'OCR'` and `'ICLASS_MATERIAL'`. No DB migration is required (`source` is a plain `String` column). The Prisma schema comment for `source` SHOULD be updated to document `OCR | ICLASS_MATERIAL | MANUAL`.

The `InventorySuggestionRepository` port MUST expose a `create(s: TaskInventorySuggestion): Promise<TaskInventorySuggestion>` method. This method MUST NOT apply natural-key upsert logic — it inserts a new row unconditionally, so MANUAL suggestions never overwrite OCR suggestions sharing the same `serialNumber`/`mac`.

#### Scenario: source field accepts MANUAL

- GIVEN a `TaskInventorySuggestion` is constructed with `source='MANUAL'`
- WHEN it is persisted via `InventorySuggestionRepository.create()`
- THEN the stored row has `source='MANUAL'`

#### Scenario: create() does not clobber upsert rows

- GIVEN an OCR suggestion exists with `taskId=T`, `serialNumber='SN-1'`
- WHEN `create()` is called with a MANUAL suggestion for `taskId=T`, `serialNumber='SN-1'`
- THEN both rows exist independently; the OCR row's `photoUrl` and `qwenDeviceType` are unchanged
