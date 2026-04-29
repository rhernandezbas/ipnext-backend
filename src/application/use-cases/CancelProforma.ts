import { ProformaRepository } from '@domain/ports/ProformaRepository';
import { ProformaInvoice } from '@domain/entities/billing';

export class CancelProforma {
  constructor(private readonly repo: ProformaRepository) {}

  execute(id: string): Promise<ProformaInvoice | null> {
    return this.repo.update(id, { status: 'cancelled' });
  }
}
