# Proposal: IClass HTTP 429 handling + backfill per-task resilience and throttle (#33)

## Intent

After #32 made the backfill async, clicking "Reconciliar" silently does nothing. The whole batch aborts on the first IClass rate-limit hit. Root cause: the use case bursts ~78 sequential IClass calls with no inter-call delay and no per-task error isolation, tripping an HTTP 429 that propagates up and aborts the entire run.

## Diagnosis (prod evidence)

- Prod container log: `[backfill-scheduler] ERROR: IClass responded with HTTP 429`.
- `BackfillClosedServiceOrders.execute()` loops `listTasksInIClassStage` results sequentially (`for (const task of tasks) { await this.iclass.listServiceOrders(...) }`) with NO inter-task delay and NO per-task try/catch → burst → 429 → use case throws → `BackfillScheduler` catches and aborts the WHOLE batch.
- `IClassClient` already handles ONE rate-limit form: IClass's "Espere um pouco" notice arriving as a **200 plain-text body** (`isRateLimited()`, `fetchAllPages` retry at `sleep(subresourceBackoffMs*2)`), but ONLY for sub-resource fan-out. A real **HTTP 429 status** falls through `mapError()` to the generic `IClass responded with HTTP ${status}` throw. `withAuthRetry()` only re-logins on 401.
- Concept confirmed with user: the 1x1 sequential async background model is CORRECT and stays. Difference vs the LLM path: Ollama is LOCAL (no rate limit); IClass is EXTERNAL (rate-limited). Fix keeps 1x1, adds rate-limit respect.

## Scope

### In Scope
- `IClassClient`: handle HTTP 429 as a retryable rate-limit (respect `Retry-After` header in seconds, else exponential backoff off `SUBRESOURCE_BACKOFF_MS`; retry small N, e.g. 3–4; throw as today if still 429). Benefits ALL IClass calls.
- `BackfillClosedServiceOrders`: wrap each task (IClass call + processSummary) in try/catch → tally a top-level `failed`, continue the loop (one task's error must never abort the batch). Add a configurable inter-task throttle (default ~300–500ms, overridable for tests).
- Surface `failed` in the returned counts for the scheduler log.

### Out of Scope
- Job queue / BullMQ; any parallelism; changing the #32 async dispatch (stays 202 fire-and-forget, 1x1 sequential).
- Surfacing per-run results in the FE — result is logged; user observes drain via the pending page. Possible future observability follow-up, not here.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `iclass-closure-loop`: IClass adapter MUST treat HTTP 429 as retryable (Retry-After / exponential backoff, bounded retries) before throwing `IClassUnavailableError`; backfill MUST isolate per-task failures (`failed` tally, no batch abort) and throttle sequential top-level IClass calls.

## Approach

1. **IClassClient** — add a 429-aware retry around the request path (shared wrapper used by `withAuthRetry`/`authedGet`/`authedPost`, or extend `withAuthRetry`). On status 429: read `Retry-After` (seconds) if present, else exponential backoff seeded from `subresourceBackoffMs`; `sleep` then retry up to N. After N, fall through to the existing `mapError` throw. New `IClassClientOptions` knob for max attempts (test-overridable). Distinct from the existing 200-plain-text `isRateLimited` path — this is the HTTP-status path.
2. **BackfillClosedServiceOrders** — wrap each task body in try/catch; on error increment a NEW top-level `failed` (distinct from `IngestClosedCounts.errored`, which counts per-SO `processSummary` failures); `await sleep(throttleMs)` between tasks. Add `throttleMs` to `BackfillOptions` (default ~300–500ms, 0 in tests). Extend the returned counts with `failed`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/infrastructure/adapters/iclass/IClassClient.ts` | Modified | 429-aware retry (Retry-After / backoff, bounded N) before `mapError` throw; new max-attempts option |
| `src/application/use-cases/BackfillClosedServiceOrders.ts` | Modified | Per-task try/catch + `failed` tally; configurable inter-task throttle |
| `src/application/use-cases/IngestClosedServiceOrders.ts` | Modified | Add `failed` to `IngestClosedCounts` + `emptyClosedCounts()` |
| `src/infrastructure/scheduling/*` (backfill scheduler) | Modified | Log the new `failed` count per run |
| `src/__tests__/...` | Modified | TDD: 429 retry/backoff; per-task isolation; throttle paced |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Retry loop lengthens a stuck run | Med | Bound attempts (N≈3–4) + throttle; still 1x1, no concurrency |
| `failed` tally masks systemic outage | Low | Logged per run; scheduler surfaces non-zero `failed` |
| Throttle slows large backfills | Low | Configurable; async/202 so user is not blocked |
| Tests hang on real sleeps | Med | Inject `throttleMs`/backoff = 0 and a fake clock |

## Rollback Plan

Both changes are additive and isolated. Revert the two commits (IClassClient + BackfillClosedServiceOrders); `failed` defaults to 0 and the loop reverts to no-throttle. The #32 async dispatch is untouched, so reverting does not re-block "Reconciliar".

## Dependencies

- Builds on #32 (async backfill, 202 fire-and-forget). No new packages.

## Success Criteria

- [ ] An IClass HTTP 429 mid-backfill is retried (Retry-After / backoff) and the run completes.
- [ ] A single failing task increments `failed` and the remaining tasks still process.
- [ ] Sequential top-level IClass calls are paced by `throttleMs`; the burst no longer trips a 429.
- [ ] Scheduler log reports `failed` alongside existing counts.
- [ ] All tests green (TDD red→green), no real sleeps in tests.
