import {
  FinanceInvoiceTypeBucket,
  FinanceInvoiceTypeClassification,
  FinanceInvoiceTypeClassificationRepository,
} from '@domain/ports/FinanceInvoiceTypeClassificationRepository';

/**
 * finance-growth Fase 1 — `PATCH /api/finance/growth/config/invoice-types/:grType`.
 * `bucket: 'unclassified'` is rejected as an INPUT before reaching this use
 * case (validated at the route via zod, spec.md "`unclassified` NO es un
 * valor válido de entrada") — it's only ever a system default.
 */
export class ReclassifyFinanceInvoiceType {
  constructor(private readonly repo: FinanceInvoiceTypeClassificationRepository) {}

  async execute(grType: string, bucket: FinanceInvoiceTypeBucket, label: string | null = null): Promise<FinanceInvoiceTypeClassification> {
    return this.repo.updateBucket(grType, bucket, label);
  }
}
