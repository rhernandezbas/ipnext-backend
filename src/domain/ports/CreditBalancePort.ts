/**
 * twilio-credit-guard (D3.a) — port SEGREGADO (ISP): el saldo del proveedor
 * no tiene nada que ver con `TemplateMessagingPort`/`TemplateAdminPort`.
 * `InMemoryTemplateMessagingGateway` NO se toca — el fake de crédito no sabe
 * nada de templates (Approach 2 de la exploración, adoptada).
 */
export interface CreditBalance {
  /** Punto fijo de 4 decimales, ej. '17.8940'. NUNCA `number` (D2). */
  amount: string;
  /** ISO-4217 en MAYÚSCULAS tal como lo informa el proveedor, ej. 'USD'. Passthrough: NO se convierte. */
  currency: string;
  fetchedAt: Date;
  /** true = servido del slot de cache, sin request HTTP nueva. */
  cached: boolean;
}

/**
 * fix wave F1 (F1) — opciones de lectura. La cache de 60s es correcta para el
 * camino ADVISORY (`validate`, `GET /credit`), pero VENENOSA para el gate
 * fail-closed del `send`: el flujo normal de 2 pasos es `validate` (llena la
 * cache) → `send` segundos después, que comparaba contra el saldo PRE-gasto.
 */
export interface GetBalanceOptions {
  /** `true` ⇒ ignora el slot de cache, pega al proveedor y REFRESCA el slot con lo leído. */
  fresh?: boolean;
}

export interface CreditBalancePort {
  /** Throws `CreditUnavailableError` ante red/timeout/4xx/5xx/payload ilegible. NUNCA devuelve un amount dudoso. */
  getBalance(opts?: GetBalanceOptions): Promise<CreditBalance>;
  /**
   * fix wave F1 (F1) — vacía el slot de cache. Lo llama `SendExternalBulk`
   * DESPUÉS de aceptar un envío: la plata ya está comprometida, así que el
   * próximo `validate` no puede seguir mostrando el saldo de antes.
   */
  invalidate(): void;
}
