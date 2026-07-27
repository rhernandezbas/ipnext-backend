/**
 * finance-growth Fase 1 — classification catalog for GR comprobante types
 * (`grType`, e.g. "FB"/"FA"/"FX"/"ID"). Rows, never an enum (design.md
 * Decision 2, same spirit as `SEVERITY_LABEL_TO_CRITICAL` in
 * `GrafanaWebhookSource.ts`) — GR's vocabulary is external and can grow
 * without a deploy.
 */
export type FinanceInvoiceTypeBucket = 'revenue' | 'contra' | 'excluded' | 'unclassified';

export interface FinanceInvoiceTypeClassification {
  grType: string;
  bucket: FinanceInvoiceTypeBucket;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FinanceInvoiceTypeClassificationRepository {
  get(grType: string): Promise<FinanceInvoiceTypeClassification | null>;
  /**
   * Auto-alta: creates `{grType, bucket: 'unclassified'}` ONLY when no row
   * exists yet. Never overwrites an admin's prior classification (spec.md
   * "An unseen grType is auto-classified as unclassified, not dropped").
   * Returns the (possibly newly-created) row.
   */
  upsertIfAbsent(grType: string): Promise<FinanceInvoiceTypeClassification>;
  list(): Promise<FinanceInvoiceTypeClassification[]>;
  /** Admin reclassification — `bucket: 'unclassified'` is rejected at the route, never here. */
  updateBucket(grType: string, bucket: FinanceInvoiceTypeBucket, label?: string | null): Promise<FinanceInvoiceTypeClassification>;
}
