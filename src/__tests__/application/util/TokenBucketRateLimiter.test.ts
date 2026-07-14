/**
 * messaging-bulk (F2, T4.1, design §5.1, SEND-4) — `TokenBucketRateLimiter`
 * real. Molde de testabilidad `now()`/`sleep` inyectables de `GestionRealClient`
 * (retry tests): un reloj falso controlado por el test, un `sleep` espía que
 * AVANZA el reloj falso (simula el paso del tiempo sin esperar de verdad).
 *
 * SEND-4: "el limiter frena sin descartar al destinatario" — acá se prueba a
 * nivel del propio bucket: agotada la capacity, `acquire()` NUNCA rechaza,
 * siempre espera y termina resolviendo.
 */
import { TokenBucketRateLimiter } from '@application/util/TokenBucketRateLimiter';

function makeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('TokenBucketRateLimiter', () => {
  it('SEND-4: acquire resuelve sin esperar mientras hay tokens (capacity cubre las llamadas)', async () => {
    const clock = makeClock();
    const sleep = jest.fn().mockResolvedValue(undefined);
    const limiter = new TokenBucketRateLimiter({ ratePerSec: 5, capacity: 5, now: clock.now, sleep });

    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }

    expect(sleep).not.toHaveBeenCalled();
  });

  it('SEND-4: agotada la capacity, el siguiente acquire ESPERA (nunca rechaza) hasta el refill', async () => {
    const clock = makeClock();
    const sleep = jest.fn(async (ms: number) => {
      clock.advance(ms);
    });
    const limiter = new TokenBucketRateLimiter({ ratePerSec: 2, capacity: 2, now: clock.now, sleep });

    await limiter.acquire();
    await limiter.acquire(); // agota los 2 tokens, sin esperar
    expect(sleep).not.toHaveBeenCalled();

    await expect(limiter.acquire()).resolves.toBeUndefined(); // el 3ro espera y TERMINA resolviendo (no rechaza)
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(500); // 1 token faltante a 2/s ⇒ ~500ms
  });

  it('SEND-4: el refill respeta el ratePerSec configurado (rate mayor ⇒ espera menor)', async () => {
    const clock = makeClock();
    const sleep = jest.fn(async (ms: number) => {
      clock.advance(ms);
    });
    const limiter = new TokenBucketRateLimiter({ ratePerSec: 10, capacity: 1, now: clock.now, sleep });

    await limiter.acquire(); // consume el único token
    await limiter.acquire(); // espera ~100ms (1 token a 10/s)

    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(100);
    expect(sleep.mock.calls[0][0]).toBeLessThan(200);
  });

  it('SEND-4: si el refill avanza más lento de lo esperado, reintenta la espera sin rechazar nunca', async () => {
    const clock = makeClock();
    const sleep = jest.fn(async (ms: number) => {
      clock.advance(ms / 2); // simula un "reloj" que avanza más lento que lo pedido
    });
    const limiter = new TokenBucketRateLimiter({ ratePerSec: 2, capacity: 1, now: clock.now, sleep });

    await limiter.acquire();
    await expect(limiter.acquire()).resolves.toBeUndefined(); // necesita 2+ vueltas de espera, nunca tira

    expect(sleep.mock.calls.length).toBeGreaterThan(1);
  });

  it('capacity default = ratePerSec (permite burst de 1s)', async () => {
    const clock = makeClock();
    const sleep = jest.fn().mockResolvedValue(undefined);
    const limiter = new TokenBucketRateLimiter({ ratePerSec: 3, now: clock.now, sleep }); // sin capacity explícito

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    expect(sleep).not.toHaveBeenCalled(); // las 3 entran en el burst inicial
  });

  // ── FIX-7b: guard del ctor contra config inválida (loop infinito) ──────────
  it('FIX-7b: ratePerSec <= 0 revienta en el ctor (evita loop infinito reteniendo el lock)', () => {
    expect(() => new TokenBucketRateLimiter({ ratePerSec: 0 })).toThrow(/ratePerSec/);
    expect(() => new TokenBucketRateLimiter({ ratePerSec: -5 })).toThrow(/ratePerSec/);
  });

  it('FIX-7b: ratePerSec NaN revienta en el ctor', () => {
    expect(() => new TokenBucketRateLimiter({ ratePerSec: Number.NaN })).toThrow(/ratePerSec/);
  });

  it('FIX-7b: capacity < 1 revienta en el ctor', () => {
    expect(() => new TokenBucketRateLimiter({ ratePerSec: 80, capacity: 0 })).toThrow(/capacity/);
    expect(() => new TokenBucketRateLimiter({ ratePerSec: 80, capacity: 0.5 })).toThrow(/capacity/);
  });

  it('FIX-7b: config válida NO revienta', () => {
    expect(() => new TokenBucketRateLimiter({ ratePerSec: 80 })).not.toThrow();
    expect(() => new TokenBucketRateLimiter({ ratePerSec: 1, capacity: 1 })).not.toThrow();
  });
});
