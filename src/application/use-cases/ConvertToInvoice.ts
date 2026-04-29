import { ProformaRepository } from '@domain/ports/ProformaRepository';
import { ProformaInvoice } from '@domain/entities/billing';

export class ConvertToInvoice {
  constructor(private readonly repo: ProformaRepository) {}

  execute(id: string, invoiceId: string): Promise<ProformaInvoice | null> {
    return this.repo.update(id, {
      status: 'paid',
      convertedToInvoiceId: invoiceId,
    });
  }
}
