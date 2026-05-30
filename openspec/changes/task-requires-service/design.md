<!-- generated from engram topic_key: sdd/task-requires-service/design -->
## Design — task-requires-service (Backend)

### 1. Scope summary

Two surgical edits + test updates. No migration, no new files, no new ports.

---

### 2. DTO change — `CreateTaskBaseSchema` (scheduling.dto.ts:62)

**Current:**
```ts
serviceId: z.string().min(1).nullable().optional(),
```

**New:**
```ts
serviceId: z.string().min(1),
```

**Rationale:**
- `z.string().min(1)` makes the field required (Zod rejects missing and rejects empty string).
- Removing `.nullable()` makes Zod reject `null` explicitly — REQ-CREATE-SERVICE-2.
- `UpdateTaskBaseSchema` is defined as `CreateTaskBaseSchema.partial()` — `.partial()` wraps every field in `z.optional()`, so `serviceId` automatically remains optional for updates. No change needed there.
- The Prisma column `ScheduledTask.serviceId` stays `String?` (nullable). The constraint is app-layer only. The domain type `ScheduledTask.serviceId: string | null` also stays unchanged — existing tasks created before this rule may have `null` in the DB and are served as-is.

**TypeScript ripple:** `CreateTaskInput.serviceId` is still `string | null` (from the domain entity). The DTO parse output will now be `string` (non-nullable). The `normalized` object in the route coerces `data.serviceId ?? null` — this coerce is now dead code (data.serviceId is always a non-null string after parse) but harmless. It can be removed or left; leave it for symmetry with other FK fields to avoid noise in the diff.

---

### 3. Use-case change — `CreateTask.ts` (lines 23-26)

**Remove the null guard:**
```ts
// BEFORE
if (data.serviceId != null) {
  const found = await this.serviceLookup.findById(data.serviceId);
  if (!found) throw new ReferenceNotFoundError('service', data.serviceId);
}

// AFTER
const foundService = await this.serviceLookup.findById(data.serviceId);
if (!foundService) throw new ReferenceNotFoundError('service', data.serviceId);
```

**Rationale:** `serviceId` is now guaranteed non-null by the DTO schema. The guard was the only thing making the validation conditional. Removing it makes the lookup unconditional — REQ-UC-SERVICE-1. No other FK fields change.

**FK order preserved:** customer → **service (unconditional)** → partner → project → reporter → assignee → watchers. REQ-FK-ORDER-1 is unaffected.

**Domain layer purity:** `CreateTask.ts` imports nothing from `infrastructure/`. The `serviceLookup` is an `EntityLookup` port — no DIP violation.

---

### 4. Error contract

| Scenario | HTTP | Code |
|---|---|---|
| `serviceId` missing or `null` | 400 | `VALIDATION_ERROR` (Zod, at route parse) |
| `serviceId: ""` | 400 | `VALIDATION_ERROR` (Zod `min(1)`) |
| `serviceId` present but not found | 404 | `SERVICE_NOT_FOUND` (mapped from `ReferenceNotFoundError`) |
| `serviceId` valid | 201 | — |

The route already maps `ReferenceNotFoundError` → 404 with `REFERENCE_TO_CODE[err.kind]`. Confirm that `REFERENCE_TO_CODE` has a `'service'` key (it does — it was added in the `task-service-location` change).

---

### 5. Test strategy

#### 5.1 Tests to INVERT (currently passing, must become failing after the change)

| File | Test description | New behavior |
|---|---|---|
| `src/__tests__/application/use-cases/CreateTask.test.ts` | `'null FKs skip validation'` (line ~214) — passes `serviceId: null` and expects success | Must now call `serviceLookup.findById(null)` → stub returns null → throws `ReferenceNotFoundError`. Either remove this test or invert it to expect the error. |
| `src/__tests__/application/use-cases/CreateTask.test.ts` | `'happy path: no FKs provided → creates task without lookup'` (line ~208) — `makeBase()` has `serviceId: null` | Fixture must add a valid `serviceId` and the `makeUseCase()` must wire a `serviceLookup` that knows about it. |
| `src/__tests__/infrastructure/schedulingServiceId.routes.test.ts` | `'allows creating a task without serviceId (null)'` (line ~87) — expects 201 | Must be inverted to expect 400 `VALIDATION_ERROR`. |
| `src/__tests__/infrastructure/schedulingServiceId.routes.test.ts` | `PUT` create-without-serviceId fixture (line ~107-113) — creates task without serviceId as setup step | Add `serviceId` to the create body, keep `SERVICE_ID` already defined. |

#### 5.2 Tests to ADD

| File | Scenario | Assertion |
|---|---|---|
| `src/__tests__/application/dto/scheduling.dto.test.ts` | `serviceId` absent → parse fails | `r.success === false` |
| `src/__tests__/application/dto/scheduling.dto.test.ts` | `serviceId: null` → parse fails | `r.success === false` |
| `src/__tests__/application/dto/scheduling.dto.test.ts` | `serviceId: ""` → parse fails | `r.success === false` |
| `src/__tests__/application/dto/scheduling.dto.test.ts` | `UpdateTaskSchema` without `serviceId` → still succeeds | `r.success === true` |
| `src/__tests__/application/use-cases/CreateTask.test.ts` | `serviceId` missing from input (simulate by setting `undefined`) → throws | `ReferenceNotFoundError` kind `'service'` |
| `src/__tests__/infrastructure/scheduling.routes.test.ts` | `POST /api/scheduling` without `serviceId` → 400 | body has `code: 'VALIDATION_ERROR'` |

#### 5.3 Fixtures audit

`makeBase()` in `CreateTask.test.ts` has `serviceId: null`. Every test that calls `uc.execute(makeBase())` or spreads `makeBase()` without overriding `serviceId` will now fail (use case will call `serviceLookup.findById(null)`, get null, throw). Strategy: add `serviceId: 'svc-default'` to `makeBase()` and register `'svc-default'` in the default `emptyLookup` — or change `makeUseCase` to accept a `serviceLookup` that always resolves. The simplest approach: in `makeUseCase`, wire `serviceLookup: new StubLookup('svc-default')` by default, and update `makeBase()` to include `serviceId: 'svc-default'`. Tests that specifically test service-not-found override the lookup explicitly.

---

### 6. BE ↔ FE coordination

The BE validates `serviceId` at the Zod parse step before the use case runs. The 400 response has shape:
```json
{ "error": "Validation error", "code": "VALIDATION_ERROR", "details": [{ "path": ["serviceId"], ... }] }
```
The FE must never send a request without `serviceId` when a client is selected (enforced by the FE change). If the FE is rolled back or has a bug, the BE 400 is the safety net. The FE already has a toast path for API errors — no additional BE change needed.

**Rollout order:** Deploy BE first (stricter), then FE. During the window between BE and FE deploy, users may see an API error toast when submitting without a service. This window should be short (same deploy session).
