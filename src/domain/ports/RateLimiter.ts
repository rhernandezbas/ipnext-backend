/**
 * messaging-bulk (F2, design §5.1) — token-bucket rate limiter port. `acquire()`
 * resolves once the caller may proceed with the next send.
 *
 * Port only (this file). Implementations: `ImmediateRateLimiter` (in-memory,
 * no-op — tests) and `TokenBucketRateLimiter` (real, proactive ~80/s) both
 * belong to Batch 4 (SendCampaign), where they get their first consumer —
 * defining just the interface here has zero behavior and zero risk.
 */
export interface RateLimiter {
  acquire(): Promise<void>;
}
