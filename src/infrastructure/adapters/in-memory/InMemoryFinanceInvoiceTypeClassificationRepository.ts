import {
  FinanceInvoiceTypeBucket,
  FinanceInvoiceTypeClassification,
  FinanceInvoiceTypeClassificationRepository,
} from '@domain/ports/FinanceInvoiceTypeClassificationRepository';

export class InMemoryFinanceInvoiceTypeClassificationRepository implements FinanceInvoiceTypeClassificationRepository {
  rows = new Map<string, FinanceInvoiceTypeClassification>();

  async get(grType: string): Promise<FinanceInvoiceTypeClassification | null> {
    return this.rows.get(grType) ?? null;
  }

  async upsertIfAbsent(grType: string): Promise<FinanceInvoiceTypeClassification> {
    const existing = this.rows.get(grType);
    if (existing) return existing;
    const now = new Date();
    const created: FinanceInvoiceTypeClassification = {
      grType,
      bucket: 'unclassified',
      label: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(grType, created);
    return created;
  }

  async list(): Promise<FinanceInvoiceTypeClassification[]> {
    return Array.from(this.rows.values());
  }

  async updateBucket(grType: string, bucket: FinanceInvoiceTypeBucket, label: string | null = null): Promise<FinanceInvoiceTypeClassification> {
    const existing = this.rows.get(grType);
    const now = new Date();
    const updated: FinanceInvoiceTypeClassification = existing
      ? { ...existing, bucket, label: label ?? existing.label, updatedAt: now }
      : { grType, bucket, label, createdAt: now, updatedAt: now };
    this.rows.set(grType, updated);
    return updated;
  }

  /** Test helper — seed a classification directly without going through upsertIfAbsent. */
  seed(grType: string, bucket: FinanceInvoiceTypeBucket, label: string | null = null): void {
    const now = new Date();
    this.rows.set(grType, { grType, bucket, label, createdAt: now, updatedAt: now });
  }
}
