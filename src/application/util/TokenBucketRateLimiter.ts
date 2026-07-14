import { RateLimiter } from '@domain/ports/RateLimiter';

export interface TokenBucketRateLimiterOptions {
  /** Tasa sostenida de refill, tokens/segundo (prod ~80, `MESSAGING_BULK_RATE_PER_SEC`). */
  ratePerSec: number;
  /** Tope de burst. Default = `ratePerSec` (permite vaciar 1s de burst, luego sostenido). */
  capacity?: number;
  /** Reloj inyectable (ms) — tests deterministas. Default `Date.now`. */
  now?: () => number;
  /** Delay inyectable — tests pasan un spy que avanza un reloj falso. Default setTimeout (unref). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // No mantener vivo el event loop por una espera de rate-limit pendiente
    // (mismo patrón que GestionRealClient — SIGTERM/deploy limpio).
    (timer as { unref?: () => void }).unref?.();
  });

/**
 * messaging-bulk (F2, design §5.1, T4.1, SEND-4) — rate limiter PROACTIVO
 * (token bucket) para `SendCampaign`. `acquire()` resuelve de inmediato si hay
 * token disponible; si no, ESPERA (nunca rechaza/descarta al caller — SEND-4
 * "el limiter frena sin descartar al destinatario") hasta que el refill deje
 * un token libre, y reintenta.
 *
 * `now()`/`sleep` inyectables (mismo criterio de testabilidad que
 * `GestionRealClient.backoffMs`) → tests deterministas sin esperar tiempo real.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  private readonly ratePerSec: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens: number;
  private lastRefillMs: number;

  constructor(opts: TokenBucketRateLimiterOptions) {
    // fix wave (FIX-7b) — guard fail-fast: con `ratePerSec <= 0` el refill nunca
    // sumaría tokens y `acquire()` quedaría en un LOOP INFINITO reteniendo el
    // lock de la campaña (deadlock). Con `capacity < 1` ningún token cabría.
    // NaN también cae acá (toda comparación con NaN es false). Revienta en
    // construcción, no en runtime silencioso.
    if (!(opts.ratePerSec > 0)) {
      throw new Error(`TokenBucketRateLimiter: ratePerSec debe ser > 0 (recibió ${opts.ratePerSec})`);
    }
    const capacity = opts.capacity ?? opts.ratePerSec;
    if (!(capacity >= 1)) {
      throw new Error(`TokenBucketRateLimiter: capacity debe ser >= 1 (recibió ${capacity})`);
    }
    this.ratePerSec = opts.ratePerSec;
    this.capacity = capacity;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.tokens = this.capacity;
    this.lastRefillMs = this.now();
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const missing = 1 - this.tokens;
      const waitMs = Math.max(1, Math.ceil((missing / this.ratePerSec) * 1000));
      await this.sleep(waitMs);
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsedMs = now - this.lastRefillMs;
    if (elapsedMs <= 0) return;
    const refillAmount = (elapsedMs / 1000) * this.ratePerSec;
    this.tokens = Math.min(this.capacity, this.tokens + refillAmount);
    this.lastRefillMs = now;
  }
}
