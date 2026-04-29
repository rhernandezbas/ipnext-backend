import { CreditNoteRepository } from '@domain/ports/CreditNoteRepository';
import { CreditNote } from '@domain/entities/billing';

export class ApplyCreditNote {
  constructor(private readonly repo: CreditNoteRepository) {}

  execute(id: string): Promise<CreditNote | null> {
    return this.repo.update(id, {
      status: 'applied',
      appliedAt: new Date().toISOString(),
    });
  }
}
