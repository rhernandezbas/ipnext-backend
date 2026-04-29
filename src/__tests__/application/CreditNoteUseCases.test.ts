import { InMemoryCreditNoteRepository } from '../../infrastructure/adapters/in-memory/InMemoryCreditNoteRepository';
import { ListCreditNotes } from '../../application/use-cases/ListCreditNotes';
import { CreateCreditNote } from '../../application/use-cases/CreateCreditNote';
import { ApplyCreditNote } from '../../application/use-cases/ApplyCreditNote';

function makeRepo() {
  return new InMemoryCreditNoteRepository();
}

describe('ListCreditNotes', () => {
  it('returns 6 seeded credit notes', async () => {
    const repo = makeRepo();
    const uc = new ListCreditNotes(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(6);
  });
});

describe('CreateCreditNote', () => {
  it('creates credit note with status draft', async () => {
    const repo = makeRepo();
    const uc = new CreateCreditNote(repo);

    const result = await uc.execute({
      number: 'NC-2024-007',
      clientId: 'cli-001',
      clientName: 'Test Client',
      amount: 1000,
      taxAmount: 210,
      totalAmount: 1210,
      reason: 'Test reason',
      relatedInvoiceId: null,
      issuedAt: '2024-06-01',
      notes: '',
    });

    expect(result.status).toBe('draft');
    expect(result.appliedAt).toBeNull();
    expect(result.id).toBeTruthy();
  });
});

describe('ApplyCreditNote', () => {
  it('changes credit note status to applied', async () => {
    const repo = makeRepo();
    const uc = new ApplyCreditNote(repo);

    const result = await uc.execute('3');

    expect(result).not.toBeNull();
    expect(result!.status).toBe('applied');
    expect(result!.appliedAt).not.toBeNull();
  });
});
