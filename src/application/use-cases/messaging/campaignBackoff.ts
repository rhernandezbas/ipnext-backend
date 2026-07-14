import { TemplateProviderUnavailableError } from '@domain/errors/messaging-bulk';

export interface CampaignRetryOptions {
  /** Reintentos DESPUÉS del primer intento (⇒ maxRetries+1 intentos totales). SEND-3 pide "2-3 reintentos" → default 2. */
  maxRetries?: number;
  /** Base del backoff exponencial (ms): base·3^i + jitter. Default 300 (clon `GestionRealClient`). */
  retryBaseMs?: number;
  /** Techo de CUALQUIER espera individual — acota un Retry-After hostil/mal-configurado. Default 30000. */
  maxBackoffMs?: number;
  /** Delay inyectable — tests pasan un spy no-op/deterministico. Default setTimeout (unref). */
  sleep?: (ms: number) => Promise<void>;
  /** Fuente de jitter inyectable — tests la fijan. Default Math.random. */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });

/**
 * messaging-bulk (F2, T4.2, design §5.2) — backoff exponencial 429-aware,
 * clon del RAZONAMIENTO de `GestionRealClient.backoffMs` (mismo `base·3^i +
 * jitter`, mismo respeto por un `retryAfterMs` explícito, mismo cap
 * `maxBackoffMs` contra un Retry-After hostil). Adaptado al error TIPADO del
 * port en vez de leer headers axios crudos — el mapeo ya lo hizo el adapter.
 */
export function campaignBackoffMs(
  attempt: number,
  retryAfterMs: number | undefined,
  opts: { retryBaseMs: number; maxBackoffMs: number; random: () => number },
): number {
  const exp = opts.retryBaseMs * Math.pow(3, attempt);
  const jitter = Math.floor(opts.random() * opts.retryBaseMs);
  const raw = Math.max(exp + jitter, retryAfterMs ?? 0);
  const bounded = Number.isFinite(raw) ? raw : exp;
  return Math.min(bounded, opts.maxBackoffMs);
}

/**
 * messaging-bulk (F2, T4.2, SEND-3) — ejecuta `send` con reintento+backoff
 * SOLO ante `TemplateProviderUnavailableError` (transient — 429/5xx/red, ya
 * mapeado por el adapter, Batch 5). Cualquier otro error (p.ej.
 * `TemplateSendRejectedError` — 4xx per-mensaje, o un error no tipado/bug) se
 * re-lanza de inmediato SIN reintentar ("error no-retryable falla sin
 * reintentar", ahorra tiempo/costo de un error que no se autocorrige).
 *
 * Usado por `SendCampaign` envolviendo `TemplateMessagingPort.sendTemplate`
 * por-destinatario — el rate limiter (`RateLimiter.acquire()`) se consulta
 * UNA vez ANTES de esta función, no dentro de cada reintento (SEND-4).
 */
export async function sendWithRetry<T>(send: () => Promise<T>, opts: CampaignRetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const retryBaseMs = opts.retryBaseMs ?? 300;
  const maxBackoffMs = opts.maxBackoffMs ?? 30000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (attempt >= maxRetries || !(err instanceof TemplateProviderUnavailableError)) throw err;
      const delay = campaignBackoffMs(attempt, err.retryAfterMs, { retryBaseMs, maxBackoffMs, random });
      await sleep(delay);
    }
  }
}
