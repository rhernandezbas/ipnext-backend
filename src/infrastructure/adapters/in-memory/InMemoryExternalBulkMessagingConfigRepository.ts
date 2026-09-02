import {
  ExternalBulkMessagingConfig,
  ExternalBulkMessagingConfigRepository,
  ExternalBulkMessagingConfigPatch,
  EXTERNAL_BULK_MESSAGING_CONFIG_DEFAULTS,
} from '@domain/ports/ExternalBulkMessagingConfigRepository';

/**
 * external-bulk-messaging (1.5) — molde `InMemoryFinanceReceiptSyncConfigRepository`.
 * CONFIG-1: `get()` sin fila previa devuelve los defaults 500/2000 (los mismos
 * que la migración siembra en Postgres, no un fallback distinto).
 */
export class InMemoryExternalBulkMessagingConfigRepository implements ExternalBulkMessagingConfigRepository {
  private config: ExternalBulkMessagingConfig | null = null;
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  async get(): Promise<ExternalBulkMessagingConfig> {
    if (this.config) return { ...this.config };
    return { ...EXTERNAL_BULK_MESSAGING_CONFIG_DEFAULTS, updatedAt: this.now().toISOString() };
  }

  async set(patch: ExternalBulkMessagingConfigPatch): Promise<ExternalBulkMessagingConfig> {
    this.config = {
      maxPerRequest: patch.maxPerRequest,
      maxPerDay: patch.maxPerDay,
      updatedAt: this.now().toISOString(),
    };
    return { ...this.config };
  }
}
