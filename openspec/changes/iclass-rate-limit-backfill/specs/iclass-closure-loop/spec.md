# Delta for iclass-closure-loop

## ADDED Requirements

### Requirement: REQ-429-RETRY-1 — IClass HTTP 429 retry with bounded backoff

When the IClass HTTP client receives a `429` response status, it MUST retry the request rather than propagating the error immediately. The client MUST respect the `Retry-After` response header (interpreted as seconds) when present; when absent, it MUST apply exponential backoff seeded from `subresourceBackoffMs`. Retries MUST be bounded to a configurable maximum (default 3–4 attempts). After exhausting all retry attempts the client MUST throw as it does today (via `mapError`). A request that succeeds on any retry attempt MUST return its data transparently to the caller. This behavior MUST be distinct from the existing 200-plain-text `isRateLimited` / "Espere um pouco" path, which remains unchanged.

#### Scenario: 429 succeeds on retry

- GIVEN the fake HTTP client returns `429` on attempt 1, then `200` with valid data on attempt 2
- WHEN the IClass client executes the request
- THEN the client sleeps before the retry (using `Retry-After` or backoff)
- AND the call returns the data from the successful attempt transparently

#### Scenario: Retry-After header takes precedence over backoff

- GIVEN the fake HTTP client returns `429` with `Retry-After: 2` header
- WHEN the client processes the response
- THEN it waits ~2 seconds (injected sleep fn receives 2000 ms) before retrying
- AND exponential backoff is NOT used for that attempt

#### Scenario: Retries are capped — no unbounded loop

- GIVEN the fake HTTP client always returns `429`
- WHEN the client retries up to the configured max (e.g. 3 attempts)
- THEN it stops retrying after the max and throws the rate-limit error
- AND the sleep function is called exactly (max - 1) times (once between each pair of attempts)

#### Scenario: 429 retry is independent of 200-plain-text rate-limit path

- GIVEN the fake HTTP client returns `200` with body containing "Espere um pouco"
- WHEN the client processes the response
- THEN the existing `isRateLimited` / "Espere um pouco" retry path handles it
- AND the HTTP-status 429 path is NOT triggered

---

### Requirement: REQ-TASK-ISOLATION-1 — Backfill per-task failure isolation

`BackfillClosedServiceOrders.execute()` MUST wrap each top-level task iteration (IClass call + `processSummary`) in a `try/catch`. A thrown error for one task MUST increment a new top-level `failed` counter and MUST NOT abort the remaining tasks in the batch. The `failed` counter MUST be distinct from `IngestClosedCounts.errored` (which counts per-SO `processSummary` failures). The returned counts object MUST include `failed`.

#### Scenario: One failing task does not abort the batch

- GIVEN a backfill run with 3 tasks where task 2 throws during its IClass call
- WHEN `execute()` completes
- THEN tasks 1 and 3 are processed normally
- AND the returned counts include `failed: 1`
- AND tasks 1 and 3 contribute their counts to `mirrored`, `skippedNotClosed`, etc.

#### Scenario: Zero failures — failed is 0

- GIVEN all tasks in the batch succeed
- WHEN `execute()` completes
- THEN the returned counts include `failed: 0`

#### Scenario: All tasks fail — batch completes without throwing

- GIVEN all tasks throw during their IClass calls
- WHEN `execute()` completes
- THEN it does NOT throw; it returns counts with `failed` equal to the task count
- AND `mirrored`, `transitioned`, etc. are all 0

---

### Requirement: REQ-THROTTLE-1 — Configurable inter-task delay

`BackfillClosedServiceOrders` MUST accept a configurable `throttleMs` option (default ~300–500 ms in production, 0 in tests). After processing each task (success or failure), the use case MUST `await sleep(throttleMs)` before starting the next task. The `sleep` function MUST be injectable so tests can assert it is called without real delays.

#### Scenario: Sleep is called between tasks

- GIVEN a backfill run with 3 tasks and an injected spy sleep function
- WHEN `execute()` completes
- THEN the spy is called exactly 3 times (once after each task, including the last)
- OR the spy is called exactly 2 times (once between each pair of tasks) — either convention is valid as long as it is consistent

#### Scenario: throttleMs = 0 in tests — no real delays

- GIVEN `throttleMs` is set to 0 and the sleep function is a real `setTimeout`-based sleep
- WHEN `execute()` runs
- THEN the test completes without real time delays (sleep resolves immediately)

---

## MODIFIED Requirements

### Requirement: REQ-STATUS-1 — Estado

`GET /api/admin/iclass/closure/status` DEBE devolver `lastRunAt` + counts `{ mirrored, transitioned, skippedNotClosed, skippedNotOurs, skippedUnchanged, failed }`; null/ceros antes del primer run. El campo `failed` cuenta las tareas cuyo IClass call arrojó error durante el batch (distinto de `errored`, que cuenta fallos por SO dentro de `processSummary`).
(Previously: counts shape was `{ mirrored, transitioned, skippedNotClosed, skippedNotOurs, skippedUnchanged }` — no `failed` field)

#### Scenario: Status includes failed count after a run with failures

- GIVEN a completed backfill run where 2 tasks failed
- WHEN `GET /api/admin/iclass/closure/status` is called
- THEN the response includes `failed: 2` alongside the other count fields

#### Scenario: Status before first run returns zeros/null

- GIVEN no backfill run has ever executed
- WHEN `GET /api/admin/iclass/closure/status` is called
- THEN `lastRunAt` is null and all counts (including `failed`) are 0 or null
