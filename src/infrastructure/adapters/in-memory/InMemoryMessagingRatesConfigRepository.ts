import {
  MessagingRatesConfig,
  MessagingRatesConfigRepository,
  MessagingRatesConfigPatch,
  MESSAGING_RATES_CONFIG_DEFAULTS,
} from '@domain/ports/MessagingRatesConfigRepository';

/**
 * twilio-credit-guard (1.6) — molde `InMemoryExternalBulkMessagingConfigRepository`.
 * RATES-1: `get()` sin fila previa devuelve los 5 defaults (los mismos que la
 * migración siembra en Postgres, no un fallback distinto).
 */
export class InMemoryMessagingRatesConfigRepository implements MessagingRatesConfigRepository {
  private config: MessagingRatesConfig | null = null;
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  async get(): Promise<MessagingRatesConfig> {
    if (this.config) return { ...this.config };
    return { ...MESSAGING_RATES_CONFIG_DEFAULTS, updatedAt: this.now().toISOString() };
  }

  async set(patch: MessagingRatesConfigPatch): Promise<MessagingRatesConfig> {
    this.config = {
      currency: patch.currency,
      utilityRate: patch.utilityRate,
      marketingRate: patch.marketingRate,
      authenticationRate: patch.authenticationRate,
      providerFee: patch.providerFee,
      updatedAt: this.now().toISOString(),
    };
    return { ...this.config };
  }
}
