import {
  FinanceInvoiceTypeClassification,
  FinanceInvoiceTypeClassificationRepository,
} from '@domain/ports/FinanceInvoiceTypeClassificationRepository';

/** finance-growth Fase 1 — `GET /api/finance/growth/config/invoice-types`. */
export class ListFinanceInvoiceTypes {
  constructor(private readonly repo: FinanceInvoiceTypeClassificationRepository) {}

  async execute(): Promise<FinanceInvoiceTypeClassification[]> {
    return this.repo.list();
  }
}
