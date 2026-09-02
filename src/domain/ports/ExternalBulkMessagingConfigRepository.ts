/**
 * external-bulk-messaging (D1/CONFIG-1) — topes editables sin redeploy, molde
 * `FinanceReceiptSyncConfigRepository`/`WhatsappTaskStageTransitionConfigRepository`.
 * Fila única (`id:'singleton'`), defaults 500/2000 SI no hay fila (CONFIG-1 —
 * los defaults nacen de la migración, pero el repo también los ofrece en código
 * como fallback fail-safe, mismo criterio que `FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS`).
 */
export interface ExternalBulkMessagingConfig {
  maxPerRequest: number;
  maxPerDay: number;
  /** ISO */
  updatedAt: string;
}

export const EXTERNAL_BULK_MESSAGING_CONFIG_DEFAULTS: Pick<
  ExternalBulkMessagingConfig,
  'maxPerRequest' | 'maxPerDay'
> = {
  maxPerRequest: 500,
  maxPerDay: 2000,
};

export interface ExternalBulkMessagingConfigPatch {
  maxPerRequest: number;
  maxPerDay: number;
}

export interface ExternalBulkMessagingConfigRepository {
  /** Config vigente; defaults 500/2000 si no hay fila persistida aún (CONFIG-1). */
  get(): Promise<ExternalBulkMessagingConfig>;
  set(patch: ExternalBulkMessagingConfigPatch): Promise<ExternalBulkMessagingConfig>;
}
