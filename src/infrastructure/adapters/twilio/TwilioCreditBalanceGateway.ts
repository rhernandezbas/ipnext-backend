import axios, { AxiosInstance } from 'axios';
import { CreditBalance, CreditBalancePort } from '@domain/ports/CreditBalancePort';
import { CreditUnavailableError } from '@domain/errors/external-bulk-messaging';
import { tryParseMoney, formatMoney } from '@domain/services/fixedPointMoney';

export interface TwilioCreditBalanceGatewayOptions {
  /** TWILIO_ACCOUNT_SID (AC…). */
  accountSid: string;
  /** TWILIO_AUTH_TOKEN. */
  authToken: string;
  /** Default 'https://api.twilio.com' — el MISMO host de `sendTemplate` (TwilioContentGateway.ts:34). */
  apiBaseUrl?: string;
  /** Inyectable para tests — JAMÁS axios/nock real (regla TDD del repo). */
  http?: AxiosInstance;
  /** Default 10_000. Más corto que los 15s de templates: esto corre en el camino caliente del send. */
  timeoutMs?: number;
  /** Reloj inyectable — molde SmartOltHttpGateway.ts:28-52. Default Date.now. */
  now?: () => number;
  /** Default 60_000 — el MISMO número que las 3 caches de SmartOltHttpGateway. */
  cacheTtlMs?: number;
}

const DEFAULT_API_BASE_URL = 'https://api.twilio.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 60_000;

interface TwilioBalanceResponse {
  balance?: unknown;
  currency?: unknown;
  account_sid?: unknown;
}

/**
 * twilio-credit-guard (D3.c) — adapter REAL de `CreditBalancePort` contra
 * `GET {apiBaseUrl}/2010-04-01/Accounts/{accountSid}/Balance.json`. Clase
 * PROPIA — NO extiende `TwilioContentGateway` (que ya implementa otros 2
 * ports): axios propio, timeout propio (10s), cache propia.
 *
 * Mapeo de errores deliberadamente MÁS SIMPLE que `mapCrudError`: acá TODO
 * (401/403/404/429/5xx/timeout/red/JSON ilegible/`balance` no parseable/
 * `currency` vacía) es `CreditUnavailableError` — no hay semántica per-mensaje
 * ni "recurso no encontrado" útil para un balance: o hay un número confiable
 * o no lo hay. La conversión de moneda NO existe acá: `currency` es
 * passthrough (la comparación contra la config vive en el use case, D4.c).
 *
 * Cache single-slot (cardinalidad 1, no un `Map`): hit si
 * `cache.expiresAt > now()`. Los errores NUNCA se cachean — un 500 momentáneo
 * no debe bloquear 60s de envíos.
 */
export class TwilioCreditBalanceGateway implements CreditBalancePort {
  private readonly http: AxiosInstance;
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;

  private cache: { value: Omit<CreditBalance, 'cached'>; expiresAt: number } | null = null;

  constructor(opts: TwilioCreditBalanceGatewayOptions) {
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.apiBaseUrl = opts.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.http = opts.http ?? axios.create({ timeout: this.timeoutMs });
  }

  private auth() {
    return { username: this.accountSid, password: this.authToken };
  }

  /**
   * fix wave F1 (F1) — `invalidate()` vacía el slot. El `send` lo llama tras
   * ACEPTAR un envío: ese saldo ya está comprometido y no puede seguir
   * sirviéndose a un `validate` posterior como si nada hubiera pasado.
   */
  invalidate(): void {
    this.cache = null;
  }

  async getBalance(opts?: { fresh?: boolean }): Promise<CreditBalance> {
    // fix wave F1 (F1) — `fresh` SALTEA el hit de cache (pero no borra el slot
    // ANTES de leer: si la request falla, el error sube y la cache vieja queda
    // como estaba — un error nunca se cachea ni destruye lo cacheado).
    if (!opts?.fresh && this.cache && this.cache.expiresAt > this.now()) {
      return { ...this.cache.value, cached: true };
    }

    let data: TwilioBalanceResponse;
    try {
      const response = await this.http.get(
        `${this.apiBaseUrl}/2010-04-01/Accounts/${this.accountSid}/Balance.json`,
        { auth: this.auth(), timeout: this.timeoutMs },
      );
      data = response.data as TwilioBalanceResponse;
    } catch {
      throw new CreditUnavailableError();
    }

    const value = this.parseBalance(data);
    this.cache = { value, expiresAt: this.now() + this.cacheTtlMs };
    return { ...value, cached: false };
  }

  /** Throws `CreditUnavailableError` para CUALQUIER body no confiable (D3.c). */
  private parseBalance(data: TwilioBalanceResponse): Omit<CreditBalance, 'cached'> {
    if (typeof data !== 'object' || data === null) {
      throw new CreditUnavailableError();
    }
    const rawBalance = data.balance;
    if (typeof rawBalance !== 'string' && typeof rawBalance !== 'number') {
      throw new CreditUnavailableError();
    }
    const micro = tryParseMoney(rawBalance);
    if (micro === null) {
      throw new CreditUnavailableError();
    }
    const currency = typeof data.currency === 'string' ? data.currency.trim().toUpperCase() : '';
    if (currency === '') {
      throw new CreditUnavailableError();
    }
    return { amount: formatMoney(micro), currency, fetchedAt: new Date(this.now()) };
  }
}
