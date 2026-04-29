import { CreditNoteRepository } from '@domain/ports/CreditNoteRepository';
import { CreditNote } from '@domain/entities/billing';

export class CreateCreditNote {
  constructor(private readonly repo: CreditNoteRepository) {}

  execute(data: Omit<CreditNote, 'id' | 'status' | 'appliedAt'>): Promise<CreditNote> {
    return this.repo.create({
      ...data,
      status: 'draft',
      appliedAt: null,
    });
  }
}
