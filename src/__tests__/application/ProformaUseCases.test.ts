import { InMemoryProformaRepository } from '../../infrastructure/adapters/in-memory/InMemoryProformaRepository';
import { ListProformas } from '../../application/use-cases/ListProformas';
import { CreateProforma } from '../../application/use-cases/CreateProforma';

function makeRepo() {
  return new InMemoryProformaRepository();
}

describe('ListProformas', () => {
  it('returns 5 seeded proforma invoices', async () => {
    const repo = makeRepo();
    const uc = new ListProformas(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(5);
  });
});

describe('CreateProforma', () => {
  it('creates proforma with status draft', async () => {
    const repo = makeRepo();
    const uc = new CreateProforma(repo);

    const result = await uc.execute({
      number: 'PRO-2024-006',
      clientId: 'cli-001',
      clientName: 'Test Client',
      items: [{ description: 'Plan 100 Mbps', quantity: 1, unitPrice: 6500, total: 6500 }],
      subtotal: 6500,
      taxAmount: 1365,
      total: 7865,
      issuedAt: '2024-06-01',
      validUntil: '2024-06-16',
      notes: '',
    });

    expect(result.status).toBe('draft');
    expect(result.convertedToInvoiceId).toBeNull();
    expect(result.id).toBeTruthy();
  });
});
