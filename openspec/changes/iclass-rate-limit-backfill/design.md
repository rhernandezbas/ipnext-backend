# Design: IClass HTTP 429 handling + backfill per-task resilience and throttle (#33)

## Technical Approach

Two isolated, additive changes that keep the #32 1x1 sequential async model:

1. **IClassClient** — make HTTP 429 a *retryable* rate-limit inside the existing request path. Extend `withAuthRetry` (the wrapper every `authedGet`/`authedPost` already flows through, so ALL calls benefit) with a bounded 429 loop: on `status === 429`, sleep `Retry-After` seconds (if the header is present) else exponential backoff seeded from `subresourceBackoffMs`, retry up to `MAX_RATE_LIMIT_RETRIES`; after exhaustion fall through to today's `mapError` throw. Untouched: the 200-plain-text `isRateLimited` path in `fetchAllPages`, and the 401 re-login branch.
2. **BackfillClosedServiceOrders** — wrap each task body (`listServiceOrders` + `processSummary`) in `try/catch`; on error bump a NEW top-level `failed` and `continue`. Add a `throttleMs` option, `await sleep(throttleMs)` between tasks. Surface `failed` through `IngestClosedCounts` so the scheduler logs it.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|----------|--------|--------------|-----------|
| 429 placement | Extend `withAuthRetry` | New `withRateLimitRetry` wrapper; per-call handling | `withAuthRetry` is the single choke point for every get/post; one change covers all. A separate wrapper duplicates token/login plumbing. |
| Backoff source | `Retry-After` (seconds) → else `subresourceBackoffMs * 2^attempt` | Fixed delay; jitter | Honor the server's hint first; reuse the existing tunable backoff so tests inject 0. Bounded N already caps worst case; jitter is overkill for 1x1. |
| Max attempts | `MAX_RATE_LIMIT_RETRIES = 4` constant; constructor override | Env var | Constants now (matches `SUBRESOURCE_BACKOFF_MS`); env is a noted future knob. Override only for tests. |
| `failed` vs `errored` | NEW separate `failed` counter | Reuse `errored` | `errored` = per-SO `processSummary` failure (inner loop). `failed` = per-TASK failure (the IClass list call or the whole task block). Distinct granularity must stay distinguishable in the log. |
| Throttle default | `throttleMs` option, default 350ms, 0 in tests | Hardcoded | Pacing the ~78-call burst is the root-cause fix; configurable keeps tests fast and prod tunable. |
| Header access | Extend `isAxiosLikeError` guard to expose `response.headers` | New guard | One guard already used for status; widen its shape. |

## Data Flow

    BackfillScheduler.run
        └─ Backfill.execute()  ──loop tasks (throttleMs between)──┐
             per task: try { listServiceOrders → processSummary } │
                       catch { counts.failed++; continue }        │
                                                                  ▼
             IClassClient.authedGet ─► withAuthRetry
                  on 401 → re-login once (existing)
                  on 429 → read Retry-After | backoff*2^n, sleep, retry ≤ N
                  exhausted/other → mapError throw (existing)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/infrastructure/adapters/iclass/IClassClient.ts` | Modify | Add `MAX_RATE_LIMIT_RETRIES`; `maxRateLimitRetries` opt; 429 loop in `withAuthRetry`; widen `isAxiosLikeError` to expose `response.headers`; `parseRetryAfterMs` helper. |
| `src/application/use-cases/BackfillClosedServiceOrders.ts` | Modify | Per-task `try/catch` + `failed++` + `continue`; `throttleMs` option (default 350) with inter-task `sleep`. |
| `src/application/use-cases/IngestClosedServiceOrders.ts` | Modify | Add `failed: number` to `IngestClosedCounts`; init in `emptyClosedCounts()`. |
| `src/infrastructure/scheduling/BackfillScheduler.ts` | Modify | Append `failed=${r.failed}` to the done-log line (~line 64). |
| `src/__tests__/...` | Modify | TDD: 429 retry/backoff/exhaustion; Retry-After honored; per-task isolation; throttle paced. |

## Interfaces / Contracts

```ts
// IClassClient.ts
const MAX_RATE_LIMIT_RETRIES = 4;
interface IClassClientOptions { /* …existing… */ maxRateLimitRetries?: number; }

// widened guard — expose headers for Retry-After
function isAxiosLikeError(e: unknown): e is {
  response?: { status?: number; headers?: Record<string, unknown>; data?: { erros?: unknown } };
}

// withAuthRetry 429 branch (pseudocode):
// for (attempt = 0; attempt <= maxRateLimitRetries; attempt++) {
//   try { return (await fn()).data }
//   catch (e) {
//     if (401 && attempt===0) { relogin; continue }
//     if (429 && attempt < maxRateLimitRetries) {
//       const ms = retryAfterMs(e) ?? subresourceBackoffMs * 2 ** attempt;
//       await sleep(ms); continue;
//     }
//     throw mapError(e);
//   }
// }
```

```ts
// BackfillClosedServiceOrders.ts
const DEFAULT_THROTTLE_MS = 350;
interface BackfillOptions { /* …existing… */ throttleMs?: number; }
// returns IngestClosedCounts (now carrying `failed`)

// IngestClosedServiceOrders.ts
interface IngestClosedCounts { /* …existing… */ failed: number; }
```

`Retry-After` parsing: integer seconds only (`parseInt`, `>0`) → `*1000`; non-numeric/date forms ignored → fall to backoff.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | 429 retried then succeeds; Retry-After honored; backoff when header absent; throws after N | Inject `http` axios mock returning `{response:{status:429,headers}}` then 200; `maxRateLimitRetries` small; `subresourceBackoffMs:0`. Assert call count. |
| Unit | one task fails → `failed=1`, others still process; throttle invoked | In-memory `IClassPort` that throws on a chosen `serviceOrderCode`; `throttleMs:0`; assert counts + remaining tasks processed. |
| Unit | `emptyClosedCounts().failed === 0` | Direct assertion. |
| Integration | scheduler log includes `failed=` | Existing BackfillScheduler test, assert log line. |

No real sleeps: `subresourceBackoffMs:0` / `throttleMs:0` zero out delays (existing test seam).

## Migration / Rollout

No migration. No schema change. FE out of scope — result is logged and observed via the pending page. Additive and revertible per the proposal rollback plan.

## Open Questions

- None blocking.
