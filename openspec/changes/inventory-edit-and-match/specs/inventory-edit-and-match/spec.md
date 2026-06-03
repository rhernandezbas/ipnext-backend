# Delta Spec — inventory-edit-and-match

> Refinement of change #8 (`service-inventory-management`). BE hexagonal + FE React. Strict TDD.  
> This is a **delta spec**: only what is NEW or CHANGED relative to the already-deployed inventory baseline.

---

## Conventions

- **MUST** / **MUST NOT**: absolute requirement (RFC 2119).  
- **SHOULD** / **SHOULD NOT**: strong recommendation with valid exceptions.  
- **MAY**: optional.  
- All error codes are JSON `{ "error": "<CODE>", "message": "..." }`.  
- "Active contract item" means a `ContractInstalledItem` with `status !== 'removed'` (or equivalent non-removed state per existing schema).  
- "Confirmed suggestion" means `TaskInventorySuggestion.status === 'confirmed'`.  
- "DEVICE suggestion" means `TaskInventorySuggestion.kind === 'DEVICE'`.

---

## F1 — Edit Confirmed Device Type + Sync

### Purpose

When an admin corrects the type of a confirmed device, both the frozen `TaskInventorySuggestion.deviceType` and the linked `ContractInstalledItem.type` MUST be updated atomically so both records remain consistent.

---

### F1-1 — Use-case `CorrectConfirmedDeviceType` exists and is reachable

**Requirement**  
The system MUST expose a use-case `CorrectConfirmedDeviceType(suggestionId: string, newType: DeviceType)` in `application/use-cases/`.

**Scenario — happy path, both records updated**
```
Given a TaskInventorySuggestion with id=S1, kind=DEVICE, status=confirmed, deviceType=ONU, confirmedItemId=I1
  And a ContractInstalledItem with id=I1, type=ONU
  And newType=ANTENNA is a valid DeviceType
When CorrectConfirmedDeviceType(S1, ANTENNA) is called
Then TaskInventorySuggestion[S1].deviceType === ANTENNA
 And ContractInstalledItem[I1].type === ANTENNA
 And the use-case returns the updated TaskInventorySuggestion (with deviceType=ANTENNA)
```

---

### F1-2 — Suggestion not found → domain error

**Requirement**  
The use-case MUST throw a domain error `SUGGESTION_NOT_FOUND` when no `TaskInventorySuggestion` exists for the given `suggestionId`.

**Scenario**
```
Given no TaskInventorySuggestion exists with id=S_MISSING
When CorrectConfirmedDeviceType(S_MISSING, ANTENNA) is called
Then a domain error SUGGESTION_NOT_FOUND is thrown
```

---

### F1-3 — Suggestion not confirmed → domain error

**Requirement**  
The use-case MUST throw a domain error `SUGGESTION_NOT_CONFIRMED` when the suggestion exists but `status !== 'confirmed'`.

**Scenario**
```
Given a TaskInventorySuggestion with id=S2, status=pending
When CorrectConfirmedDeviceType(S2, ANTENNA) is called
Then a domain error SUGGESTION_NOT_CONFIRMED is thrown
```

---

### F1-4 — Suggestion is not a DEVICE → domain error

**Requirement**  
The use-case MUST throw a domain error `SUGGESTION_NOT_A_DEVICE` when `kind !== 'DEVICE'` (e.g. MATERIAL suggestions cannot have their device type edited this way).

**Scenario**
```
Given a TaskInventorySuggestion with id=S3, kind=MATERIAL, status=confirmed
When CorrectConfirmedDeviceType(S3, ANTENNA) is called
Then a domain error SUGGESTION_NOT_A_DEVICE is thrown
```

---

### F1-5 — confirmedItemId is null → domain error

**Requirement**  
The use-case MUST throw a domain error `SUGGESTION_NOT_LINKED` when the suggestion is a confirmed DEVICE but `confirmedItemId` is null (no linked contract item to sync).

**Scenario**
```
Given a TaskInventorySuggestion with id=S4, kind=DEVICE, status=confirmed, confirmedItemId=null
When CorrectConfirmedDeviceType(S4, ANTENNA) is called
Then a domain error SUGGESTION_NOT_LINKED is thrown
```

---

### F1-6 — Invalid newType → 422 at route layer

**Requirement**  
The route handler MUST validate `newType` against the `DeviceType` catalog **before** calling the use-case. An unrecognized value MUST return HTTP 422 with error code `INVALID_ITEM_TYPE`. The use-case itself MUST NOT receive invalid enum values.

**Scenario — invalid type**
```
Given a valid suggestion S1 (DEVICE, confirmed)
When PATCH /scheduling/:taskId/inventory/suggestions/S1/type is called with body { type: "SPACESHIP" }
Then HTTP 422 is returned with { error: "INVALID_ITEM_TYPE" }
 And the use-case is never invoked
```

**Scenario — valid type**
```
Given a valid suggestion S1 (DEVICE, confirmed, confirmedItemId=I1)
When PATCH /scheduling/:taskId/inventory/suggestions/S1/type is called with body { type: "ANTENNA" }
Then HTTP 200 is returned with the updated suggestion DTO
```

---

### F1-7 — Route gated by `inventory.manage` permission

**Requirement**  
`PATCH /scheduling/:taskId/inventory/suggestions/:suggestionId/type` MUST require the `inventory.manage` granular permission. Requests without this permission MUST receive HTTP 403. Requests with it MUST proceed.

**Scenario — no permission**
```
Given a user without inventory.manage
When PATCH /scheduling/:taskId/inventory/suggestions/S1/type { type: "ANTENNA" }
Then HTTP 403 is returned
```

**Scenario — with permission**
```
Given a user with inventory.manage
 And suggestion S1 is DEVICE, confirmed, confirmedItemId=I1
When PATCH /scheduling/:taskId/inventory/suggestions/S1/type { type: "ANTENNA" }
Then HTTP 200 is returned
```

---

### F1-8 — FE edit control visible only with `inventory.manage`

**Requirement**  
In the resolved/confirmed variant of `SuggestionCard`, a type-edit control (dropdown or button) MUST be rendered only when the current user has `inventory.manage`. It MUST NOT appear for users without this permission.

**Scenario — admin sees editor**
```
Given a confirmed DEVICE suggestion card in the task inventory tab
  And the current user has inventory.manage
When the card renders
Then an edit-type control is visible
```

**Scenario — non-admin sees no editor**
```
Given the same confirmed DEVICE suggestion card
  And the current user does NOT have inventory.manage
When the card renders
Then no edit-type control is visible
```

---

### F1-9 — FE invalidates queries after successful edit

**Requirement**  
On a successful `PATCH` response, the FE MUST invalidate (or refetch) both the task suggestions query and the contract inventory query so all UI surfaces reflect the updated type immediately.

**Scenario**
```
Given the edit control submits type=ANTENNA for suggestion S1
When the PATCH returns HTTP 200
Then the suggestions list query is invalidated/refetched
 And the contract inventory query is invalidated/refetched
 And SuggestionCard now displays deviceType=ANTENNA
```

---

## F2 — Smart Match of DEVICE Suggestions Against Contract Inventory

### Purpose

When listing task inventory suggestions, each DEVICE suggestion MUST be enriched with a `match` field indicating whether the same physical device (same SN or MAC) or a same-type device already exists in the contract's active inventory, so operators can detect duplicates before confirming.

---

### F2-1 — Listing enriches DEVICE suggestions with `match` field

**Requirement**  
The use-case responsible for listing task inventory suggestions MUST enrich each DEVICE suggestion with a `match` field of type `'same_device' | 'same_type' | null`. MATERIAL suggestions MUST always have `match: null`.

**Scenario — MATERIAL suggestion always null**
```
Given a TaskInventorySuggestion with kind=MATERIAL
When the suggestions for the task are listed
Then that suggestion's match === null
```

---

### F2-2 — `same_device` when SN matches (case-insensitive, normalized)

**Requirement**  
If the suggestion's `serialNumber` (normalized: trimmed, uppercase) matches the `serialNumber` of any active contract item, the match MUST be `'same_device'`. Comparison MUST be case-insensitive and whitespace-trimmed.

**Scenario**
```
Given a DEVICE suggestion with serialNumber="abc-001"
  And an active ContractInstalledItem with serialNumber="ABC-001"
When the suggestions are listed
Then the suggestion's match === 'same_device'
```

---

### F2-3 — `same_device` when MAC matches (case-insensitive, normalized)

**Requirement**  
If the suggestion's `macAddress` (normalized: trimmed, uppercase, colons stripped) matches the `macAddress` of any active contract item (same normalization), the match MUST be `'same_device'`, even if the serial numbers differ or are absent.

**Scenario**
```
Given a DEVICE suggestion with macAddress="aa:bb:cc:dd:ee:ff", serialNumber=null
  And an active ContractInstalledItem with macAddress="AA:BB:CC:DD:EE:FF"
When the suggestions are listed
Then the suggestion's match === 'same_device'
```

---

### F2-4 — `same_type` when type matches but SN/MAC do not

**Requirement**  
If no SN or MAC match is found but the suggestion's `deviceType` equals the `type` of any active contract item, the match MUST be `'same_type'`.

**Scenario**
```
Given a DEVICE suggestion with deviceType=ONU, serialNumber="NEW-999", macAddress=null
  And an active ContractInstalledItem with type=ONU, serialNumber="OLD-001"
When the suggestions are listed
Then the suggestion's match === 'same_type'
```

---

### F2-5 — `null` when no SN, MAC, or type match

**Requirement**  
If none of the active contract items match by SN, MAC, or type, the match MUST be `null`.

**Scenario**
```
Given a DEVICE suggestion with deviceType=ROUTER, serialNumber="X-1", macAddress=null
  And active ContractInstalledItems only contain ONU and ANTENNA types with different SNs
When the suggestions are listed
Then the suggestion's match === null
```

---

### F2-6 — Removed contract items are excluded from matching

**Requirement**  
Items with `status === 'removed'` (or equivalent removed state) in the contract inventory MUST NOT participate in the match logic.

**Scenario**
```
Given a DEVICE suggestion with deviceType=ONU, serialNumber="OLD-SN"
  And a ContractInstalledItem with serialNumber="OLD-SN" and status=removed
When the suggestions are listed
Then the suggestion's match === null (the removed item is not counted)
```

---

### F2-7 — Task without contract → all DEVICE suggestions have match null

**Requirement**  
If the task has no associated contract (or the contract has no installed items), all DEVICE suggestion `match` fields MUST be `null`. This MUST NOT throw an error.

**Scenario**
```
Given a task with no linked contract
  And two DEVICE suggestions attached to it
When the suggestions are listed
Then both suggestions have match === null
 And no error is thrown
```

---

### F2-8 — Match priority: `same_device` takes precedence over `same_type`

**Requirement**  
If both a SN/MAC match and a type match could apply, the match MUST be `'same_device'` (not `'same_type'`). `same_device` always wins.

**Scenario**
```
Given a DEVICE suggestion with deviceType=ONU, serialNumber="SN-1"
  And an active ContractInstalledItem with type=ONU, serialNumber="SN-1"
When the suggestions are listed
Then the suggestion's match === 'same_device' (not 'same_type')
```

---

### F2-9 — Route for listing is gated by `inventory.read`

**Requirement**  
The existing listing route for task inventory suggestions MUST require `inventory.read`. The `match` field MUST be included in the response for users with this permission. Users without `inventory.read` MUST receive HTTP 403.

**Scenario — with permission**
```
Given a user with inventory.read
When GET /scheduling/:taskId/inventory/suggestions
Then HTTP 200 with suggestions, each DEVICE having a match field
```

**Scenario — without permission**
```
Given a user without inventory.read
When GET /scheduling/:taskId/inventory/suggestions
Then HTTP 403
```

---

### F2-10 — FE badge reflects match status

**Requirement**  
`SuggestionCard` MUST display a visual badge when `match !== null`:
- `same_device` → badge "Ya instalado: el mismo equipo" (warning style).  
- `same_type` → badge "Ya hay un/a {deviceType}" (info style).  
- `null` → no badge.

**Scenario — same_device badge**
```
Given a DEVICE suggestion card with match='same_device'
When the card renders
Then a warning badge "Ya instalado: el mismo equipo" is visible
```

**Scenario — same_type badge**
```
Given a DEVICE suggestion card with match='same_type', deviceType=ONU
When the card renders
Then an info badge "Ya hay un/a ONU" is visible
```

**Scenario — no match, no badge**
```
Given a DEVICE suggestion card with match=null
When the card renders
Then no match badge is rendered
```

---

## Cross-cutting

### CC-1 — No schema migration required

**Requirement**  
The `match` field MUST be computed at read time (derived/enriched). It MUST NOT be persisted as a column in any table. F1 updates two existing columns (`TaskInventorySuggestion.deviceType`, `ContractInstalledItem.type`) — no new columns or tables are needed.

### CC-2 — Deploy order: BE before FE

**Requirement**  
The BE MUST be deployed before the FE. The FE MUST degrade gracefully if the `match` field is absent in the response (treat as `null`) or if the `PATCH` endpoint is unavailable (hide the edit control).

### CC-3 — Strict TDD — tests before implementation

**Requirement**  
All use-case logic (F1: `CorrectConfirmedDeviceType`; F2: match enrichment) MUST be developed test-first using in-memory port implementations. Prisma MUST NOT be mocked directly in use-case tests. Route tests MUST use supertest with in-memory repos injected.
