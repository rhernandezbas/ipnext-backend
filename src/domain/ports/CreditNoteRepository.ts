import { CreditNote } from '../entities/billing';

export interface CreditNoteRepository {
  findAll(): Promise<CreditNote[]>;
  findById(id: string): Promise<CreditNote | null>;
  create(data: Omit<CreditNote, 'id'>): Promise<CreditNote>;
  update(id: string, data: Partial<CreditNote>): Promise<CreditNote | null>;
}
