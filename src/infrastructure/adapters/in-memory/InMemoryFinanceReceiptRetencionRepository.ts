import {
  FinanceReceiptRetencion,
  FinanceReceiptRetencionRepository,
} from '@domain/ports/FinanceReceiptRetencionRepository';

export class InMemoryFinanceReceiptRetencionRepository implements FinanceReceiptRetencionRepository {
  rows = new Map<string, FinanceReceiptRetencion>();

  async upsertBatch(retenciones: FinanceReceiptRetencion[]): Promise<void> {
    for (const r of retenciones) this.rows.set(r.grRetencionId, { ...r });
  }
}
