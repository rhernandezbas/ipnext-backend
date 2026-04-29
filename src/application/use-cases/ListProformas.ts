import { ProformaRepository } from '@domain/ports/ProformaRepository';
import { ProformaInvoice } from '@domain/entities/billing';

export class ListProformas {
  constructor(private readonly repo: ProformaRepository) {}

  execute(): Promise<ProformaInvoice[]> {
    return this.repo.findAll();
  }
}
