import { ProformaRepository } from '@domain/ports/ProformaRepository';
import { ProformaInvoice } from '@domain/entities/billing';

export class CreateProforma {
  constructor(private readonly repo: ProformaRepository) {}

  execute(data: Omit<ProformaInvoice, 'id' | 'status' | 'convertedToInvoiceId'>): Promise<ProformaInvoice> {
    return this.repo.create({
      ...data,
      status: 'draft',
      convertedToInvoiceId: null,
    });
  }
}
