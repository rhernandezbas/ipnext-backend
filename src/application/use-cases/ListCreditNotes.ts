import { CreditNoteRepository } from '@domain/ports/CreditNoteRepository';
import { CreditNote } from '@domain/entities/billing';

export class ListCreditNotes {
  constructor(private readonly repo: CreditNoteRepository) {}

  execute(): Promise<CreditNote[]> {
    return this.repo.findAll();
  }
}
