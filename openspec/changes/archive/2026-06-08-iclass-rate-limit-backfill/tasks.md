# Tasks: IClass HTTP 429 handling + backfill per-task resilience and throttle (#33)

## Phase 1: IClassClient — 429 retry (REQ-429-RETRY-1)

- [x] 1.1 [RED] Write test: 429 on attempt 1 → success on attempt 2 returns data transparently; assert sleep called once (`src/__tests__/infrastructure/IClassClient.429.test.ts`)
- [x] 1.2 [RED] Write test: `Retry-After: 2` header → sleep receives 2000 ms, backoff NOT used
- [x] 1.3 [RED] Write test: always-429 with `maxRateLimitRetries=3` → throws after 3 retries, sleep called exactly 2 times
- [x] 1.4 [RED] Write test: 200-body "Espere um pouco" → existing `isRateLimited` path fires, 429 path NOT triggered
- [x] 1.5 [GREEN] Widen `isAxiosLikeError` in `IClassClient.ts` (~line 46) to expose `response.headers: Record<string, unknown>`
- [x] 1.6 [GREEN] Add module constant `MAX_RATE_LIMIT_RETRIES = 4` and `maxRateLimitRetries?: number` to `IClassClientOptions`
- [x] 1.7 [GREEN] Add `parseRetryAfterMs(e)` helper (integer-seconds `Retry-After` → ms; invalid/absent → undefined)
- [x] 1.8 [GREEN] Extend `withAuthRetry` with 429 loop: `Retry-After` ms else `subresourceBackoffMs * 2^attempt`; after exhaustion fall through to `mapError`
- [x] 1.9 [REFACTOR] Confirm 401 re-login branch is untouched; ensure `subresourceBackoffMs:0` zeroes all sleeps in tests

## Phase 2: IngestClosedCounts shape (REQ-STATUS-1)

- [x] 2.1 [RED] Write test: `emptyClosedCounts().failed === 0` (`src/__tests__/application/IngestClosedServiceOrders.test.ts`)
- [x] 2.2 [RED] Write test: status endpoint response includes `failed` field (existing routes test for `GET /api/admin/iclass/closure/status`)
- [x] 2.3 [GREEN] Add `failed: number` to `IngestClosedCounts` interface in `src/application/use-cases/IngestClosedServiceOrders.ts` (~line 37)
- [x] 2.4 [GREEN] Initialize `failed: 0` in `emptyClosedCounts()` (~line 357)

## Phase 3: BackfillClosedServiceOrders — isolation + throttle (REQ-TASK-ISOLATION-1, REQ-THROTTLE-1)

- [x] 3.1 [RED] Write test: 3-task run, task 2 throws → tasks 1 and 3 process normally, `failed: 1`, no batch throw (`src/__tests__/application/BackfillClosedServiceOrders.test.ts`)
- [x] 3.2 [RED] Write test: all tasks succeed → `failed: 0`
- [x] 3.3 [RED] Write test: all tasks throw → returns without throwing, `failed` equals task count, other counts are 0
- [x] 3.4 [RED] Write test: spy sleep called exactly N times (2 or 3, consistent convention) for a 3-task run with `throttleMs` injected
- [x] 3.5 [RED] Write test: `throttleMs: 0` → run completes without real delays
- [x] 3.6 [GREEN] Add `DEFAULT_THROTTLE_MS = 350` constant and `throttleMs?: number` to `BackfillOptions` in `BackfillClosedServiceOrders.ts`
- [x] 3.7 [GREEN] Wrap task body (`listServiceOrders` + `processSummary`) in `try/catch`; on catch: `counts.failed++; continue`
- [x] 3.8 [GREEN] Add `await sleep(throttleMs)` between tasks using the existing `sleep` seam; pass 0 in tests

## Phase 4: BackfillScheduler log (REQ-STATUS-1 logging)

- [x] 4.1 [RED] Assert `BackfillScheduler` done-log line includes `failed=` (`src/__tests__/infrastructure/BackfillScheduler.test.ts`)
- [x] 4.2 [GREEN] Append `failed=${r.failed}` to the log line in `src/infrastructure/scheduling/BackfillScheduler.ts` (~line 64)

## Phase 5: Full verify

- [x] 5.1 Run `npx jest --runInBand` — all tests green
- [x] 5.2 Run `npx tsc --noEmit` — zero type errors
- [x] 5.3 Confirm 11 spec scenarios covered: 4×REQ-429-RETRY-1, 3×REQ-TASK-ISOLATION-1, 2×REQ-THROTTLE-1, 2×REQ-STATUS-1
