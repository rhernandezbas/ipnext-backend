import { RateLimiter } from '@domain/ports/RateLimiter';

/**
 * messaging-bulk (F2, T4.1) — no-op `RateLimiter` para tests deterministas de
 * `SendCampaign`: `acquire()` resuelve de inmediato, sin esperar ni consumir
 * tokens. El bucket REAL (`TokenBucketRateLimiter`) se testea aparte
 * (`application/util/TokenBucketRateLimiter.ts`).
 */
export class ImmediateRateLimiter implements RateLimiter {
  async acquire(): Promise<void> {
    // no-op — nunca frena.
  }
}
