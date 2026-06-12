# Design: node-task-required-address (#53)

## Decision
Enforce "address required for network tasks" as a DOMAIN guard returning HTTP 422, NOT a zod 400. This mirrors the existing MISSING_REQUIRED_FIELDS / PROJECT_KIND_MISMATCH precedent (semantic business rule, not a shape error). The DTO keeps `address` nullable/optional at parse time.

## Backend seam
- `domain/errors/scheduling.ts`: `NetworkTaskAddressRequiredError extends DomainError`, code `NETWORK_TASK_ADDRESS_REQUIRED`. Style mirrors `ProjectKindMismatchError`.
- `application/use-cases/CreateTask.ts`: inside the `kind === 'network'` branch, AFTER the NetworkSite existence check, throw when `!data.address?.trim()`.
- `application/use-cases/UpdateTask.ts`: guard fires only when `'address' in data && data.address !== undefined` AND the new value is blank AND the resolved existing task `kind === 'network'`. Partial updates that omit address are untouched.
- `infrastructure/http/middleware/errorHandler.ts`: `NETWORK_TASK_ADDRESS_REQUIRED: 422` added to the statusMap (single source of truth).
- `infrastructure/http/routes/scheduling.routes.ts`: explicit `instanceof NetworkTaskAddressRequiredError → res.status(422).json({ error, code })` in BOTH POST and PUT catch blocks, mirroring the ProjectKindMismatchError block. Rationale: Express 4 async route handlers that throw do not reliably reach the global error middleware; the in-route catch is the proven, consistent path. The statusMap entry remains as the canonical contract + safety net.

## Wire contract (BE → FE)
- POST /api/scheduling/tasks (kind=network, blank address): 422
  `{ error: string, code: "NETWORK_TASK_ADDRESS_REQUIRED" }`
- PUT /api/scheduling/tasks/:id (network task, address=""): 422 same body.
- Customer create/update with blank address: unchanged (no error).

## Frontend seam
- `CreateTaskModal.tsx` `canSave` network arm: `!!networkSiteId && address.trim().length > 0`.
- Dirección label asterisk rendered only when `taskMode === 'network'` (customer keeps plain label).
- Site address autofill (existing, ref-guarded, editable) untouched.

## Test seam
- Use case: CreateTask.address-guard (null/empty/whitespace reject; valid resolves; customer null OK). UpdateTask.address-guard (network blank rejects; omitted OK; customer blank OK).
- Route: POST kind=network without address → 422 code NETWORK_TASK_ADDRESS_REQUIRED (proves errorHandler/route wiring end to end).
- InMemorySchedulingRepository pre-seeds ids '1'–'7' (nextId=7) — tests must account for the first createTask returning '7' (collision); consume a dummy id first or assert on returned id.
- FE: modal network mode — node selected + blank address → button disabled; non-blank → enabled; asterisk visible; customer regression unaffected.

## Back-compat
No migration. Existing network tasks without address are not retro-validated (guard only fires on create / explicit blank-out update).
