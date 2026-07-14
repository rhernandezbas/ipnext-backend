/**
 * messaging-bulk (F2, T4.1) — `ImmediateRateLimiter`: no-op RateLimiter usado
 * por los tests de `SendCampaign` para no depender de tiempo real. `acquire()`
 * resuelve de inmediato, siempre, sin importar cuántas veces se llame.
 */
import { ImmediateRateLimiter } from '@infrastructure/adapters/in-memory/ImmediateRateLimiter';

describe('ImmediateRateLimiter', () => {
  it('acquire() resuelve de inmediato (no-op) — no bloquea ni cuenta llamadas', async () => {
    const limiter = new ImmediateRateLimiter();
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('acquire() resuelve de inmediato en llamadas repetidas (nunca frena)', async () => {
    const limiter = new ImmediateRateLimiter();
    for (let i = 0; i < 100; i++) {
      await limiter.acquire();
    }
  });
});
