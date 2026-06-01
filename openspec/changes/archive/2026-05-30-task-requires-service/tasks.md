<!-- generated from engram topic_key: sdd/task-requires-service/tasks -->
## Tasks — task-requires-service (Backend)
Strict TDD: every task starts with a failing test. Test runner: `npm test`.

### Phase A — Red (write/invert failing tests first)

- [ ] A.1 — **INVERT** `'null FKs skip validation'` in `CreateTask.test.ts` (~line 214): change the test to expect `ReferenceNotFoundError` with `kind: 'service'` when `serviceId: null` is passed. (This test currently passes — it should now be RED.)
- [ ] A.2 — **UPDATE** `makeBase()` in `CreateTask.test.ts`: add `serviceId: 'svc-default'`. Update `makeUseCase()` default `serviceLookup` to `new StubLookup('svc-default')`. Verify all existing tests that spread `makeBase()` still use a valid serviceId.
- [ ] A.3 — **INVERT** `'allows creating a task without serviceId (null)'` in `schedulingServiceId.routes.test.ts` (~line 87): expect `status 400` and `body.code === 'VALIDATION_ERROR'` instead of 201.
- [ ] A.4 — **ADD** `serviceId` to the `PUT` setup fixture in `schedulingServiceId.routes.test.ts` (~line 107-113): include `serviceId: SERVICE_ID` in the create body so setup succeeds after the DTO tightening.
- [ ] A.5 — **ADD** DTO unit tests in `scheduling.dto.test.ts`:
  - `serviceId` absent → `CreateTaskSchema.safeParse` returns `success: false`.
  - `serviceId: null` → `success: false`.
  - `serviceId: ""` → `success: false`.
  - `UpdateTaskSchema` without `serviceId` → `success: true` (regression guard).
- [ ] A.6 — **ADD** route integration test in `scheduling.routes.test.ts`: `POST /api/scheduling` without `serviceId` → `status 400`, `code: 'VALIDATION_ERROR'`.
- [ ] A.7 — Run `npm test` — confirm A.1, A.3, A.5, A.6 are RED (failing); A.2, A.4 may be green already.

### Phase B — Green (implementation)

- [ ] B.1 — **DTO**: in `src/application/dto/scheduling.dto.ts` line ~62, change `serviceId: z.string().min(1).nullable().optional()` → `serviceId: z.string().min(1)`. No other lines in the file change.
- [ ] B.2 — **Use case**: in `src/application/use-cases/CreateTask.ts` lines ~23-26, remove the `if (data.serviceId != null)` guard. Replace with unconditional lookup:
  ```ts
  const foundService = await this.serviceLookup.findById(data.serviceId);
  if (!foundService) throw new ReferenceNotFoundError('service', data.serviceId);
  ```
- [ ] B.3 — Run `npm test` — all tests from Phase A must now be GREEN. Fix any collateral failures in other test files that have fixtures omitting `serviceId` (add `serviceId` to their create bodies).
- [ ] B.4 — Run `tsc --noEmit` — must be clean.

### Phase C — Cleanup & verification

- [ ] C.1 — Audit all supertest `POST /api/scheduling` calls across the test suite (grep `post('/api/scheduling')`) — add `serviceId` to any fixture that omits it and would now fail.
- [ ] C.2 — Confirm `PUT /api/scheduling/:id` tests are unaffected (UpdateTaskSchema is `.partial()` — no change).
- [ ] C.3 — Final `npm test` green.
- [ ] C.4 — Final `tsc --noEmit` clean.

### Files touched

| File | Change |
|---|---|
| `src/application/dto/scheduling.dto.ts` | Line ~62: remove `.nullable().optional()` |
| `src/application/use-cases/CreateTask.ts` | Lines ~23-26: remove null-guard, unconditional lookup |
| `src/__tests__/application/use-cases/CreateTask.test.ts` | Invert `null FKs` test; update `makeBase()` + `makeUseCase()`; add 1 new scenario |
| `src/__tests__/application/dto/scheduling.dto.test.ts` | Add 4 new DTO scenarios |
| `src/__tests__/infrastructure/schedulingServiceId.routes.test.ts` | Invert no-serviceId test; fix PUT fixture |
| `src/__tests__/infrastructure/scheduling.routes.test.ts` | Add 1 new route scenario |
| Other `*.routes.test.ts` with POST fixtures (audit in C.1) | Add `serviceId` to create bodies as needed |

### Estimated complexity
- Files touched: 4–8 (2 production + 4 test + up to 2 collateral fixtures)
- No new files, no migration, no DI wiring changes
- Total tasks: 13 (6 red + 4 green + 3 cleanup)
