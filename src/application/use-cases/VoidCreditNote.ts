import { CreditNoteRepository } from '@domain/ports/CreditNoteRepository';
import { CreditNote } from '@domain/entities/billing';

export class VoidCreditNote {
  constructor(private readonly repo: CreditNoteRepository) {}

  execute(id: string): Promise<CreditNote | null> {
    return this.repo.update(id, { status: 'voided' });
  }
}
