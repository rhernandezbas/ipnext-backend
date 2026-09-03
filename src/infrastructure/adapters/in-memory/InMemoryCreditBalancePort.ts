import { CreditBalance, CreditBalancePort, GetBalanceOptions } from '@domain/ports/CreditBalancePort';
import { CreditUnavailableError } from '@domain/errors/external-bulk-messaging';

const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * twilio-credit-guard (1.6, D3.c) — fake settable para tests de use cases
 * (`ValidateExternalBulk`/`SendExternalBulk`). `calls` es el mecanismo de pin
 * de "una sola request"/"replay no llama getBalance()" (CG-SEND-4, B3).
 *
 * ── fix wave F1 (finding F2): TWIN, NO STUB ─────────────────────────────────
 * La versión anterior devolvía `amount` SIEMPRE fresco y con un `cached`
 * decorativo (`cachedNext`). Con eso, el bug F1 (el `send` comparando contra
 * el saldo PRE-gasto que dejó cacheado el `validate` de hace 30 segundos) era
 * literalmente INTESTEABLE con el twin: no había cache que envenenar.
 *
 * Ahora replica campo a campo la semántica de `TwilioCreditBalanceGateway`:
 *   - cache single-slot (cardinalidad 1, no un `Map`), hit ssi `expiresAt > now()`
 *   - reloj `now: () => number` inyectable, TTL default 60_000 (el MISMO número)
 *   - `cached` REAL (true solo en un hit de slot)
 *   - `{fresh:true}` saltea el hit y REFRESCA el slot
 *   - `invalidate()` vacía el slot
 *   - el error NUNCA se cachea ni pisa el slot vigente
 *
 * Dos contadores, con roles distintos:
 *   - `calls`   — invocaciones de `getBalance()` (incluye hits de cache y
 *                 fallos). Pinea "el gate NO corrió" / "el replay no re-chequea".
 *   - `fetches` — lecturas de ORIGEN (cache miss). Es el equivalente exacto del
 *                 `http.get` del gateway: lo que pinea la invalidación.
 */
export class InMemoryCreditBalancePort implements CreditBalancePort {
  public amount: string;
  public currency: string;
  public fetchedAt: Date;
  /** true ⇒ cada lectura de ORIGEN tira `CreditUnavailableError` (los hits de cache no llegan a evaluarlo). */
  public failNext: boolean;
  /** Contador público de invocaciones — pinea "el gate no corrió" / "el replay no re-chequea". */
  public calls = 0;
  /** Contador público de lecturas de ORIGEN (cache miss) — equivalente al `http.get` del gateway. */
  public fetches = 0;

  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private cache: { value: Omit<CreditBalance, 'cached'>; expiresAt: number } | null = null;

  constructor(opts?: {
    amount?: string;
    currency?: string;
    fetchedAt?: Date;
    failNext?: boolean;
    /** Reloj inyectable en ms — molde EXACTO del gateway. Default `Date.now`. */
    now?: () => number;
    /** Default 60_000 — el MISMO número que el gateway. */
    cacheTtlMs?: number;
  }) {
    this.amount = opts?.amount ?? '17.8940';
    this.currency = opts?.currency ?? 'USD';
    this.fetchedAt = opts?.fetchedAt ?? new Date();
    this.failNext = opts?.failNext ?? false;
    this.now = opts?.now ?? (() => Date.now());
    this.cacheTtlMs = opts?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  invalidate(): void {
    this.cache = null;
  }

  async getBalance(opts?: GetBalanceOptions): Promise<CreditBalance> {
    this.calls += 1;
    if (!opts?.fresh && this.cache && this.cache.expiresAt > this.now()) {
      return { ...this.cache.value, cached: true };
    }

    this.fetches += 1;
    if (this.failNext) {
      // El error NO se cachea NI pisa el slot vigente (paridad con el gateway).
      throw new CreditUnavailableError();
    }

    const value = { amount: this.amount, currency: this.currency, fetchedAt: this.fetchedAt };
    this.cache = { value, expiresAt: this.now() + this.cacheTtlMs };
    return { ...value, cached: false };
  }
}
