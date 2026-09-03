/**
 * twilio-credit-guard (D3.b) — molde EXACTO `ExternalBulkMessagingConfigRepository`.
 * Fila única (`id:'singleton'`), defaults en código (RATES-1 — los mismos que
 * la migración siembra en Postgres via el default de columna, no un fallback
 * distinto). Las 4 tarifas viajan como `string` de 4 decimales, NUNCA `number`
 * (D2 — la decisión que mata el riesgo de float en origen).
 */
export interface MessagingRatesConfig {
  /** ISO-4217, 3 letras MAYÚSCULAS. */
  currency: string;
  /** '0.0120' — string de 4 decimales, D2. */
  utilityRate: string;
  /** '0.0618' */
  marketingRate: string;
  /** '0.0220' */
  authenticationRate: string;
  /** '0.0050' — fee Twilio por mensaje. */
  providerFee: string;
  /** ISO. */
  updatedAt: string;
}

export const MESSAGING_RATES_CONFIG_DEFAULTS: Omit<MessagingRatesConfig, 'updatedAt'> = {
  currency: 'USD',
  utilityRate: '0.0120',
  marketingRate: '0.0618',
  authenticationRate: '0.0220',
  providerFee: '0.0050',
};

export type MessagingRatesConfigPatch = Omit<MessagingRatesConfig, 'updatedAt'>;

export interface MessagingRatesConfigRepository {
  /** Config vigente; defaults si no hay fila persistida aún (RATES-1). */
  get(): Promise<MessagingRatesConfig>;
  set(patch: MessagingRatesConfigPatch): Promise<MessagingRatesConfig>;
}
