import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { GrInvoice } from '@domain/entities/gestionReal';

function makeGrInvoice(numero: string, overrides: Partial<GrInvoice> = {}): GrInvoice {
  return {
    tipo: 'FB',
    sucursal: '00010',
    numero,
    moneda: 'PES',
    fecha: '26-06-2026',
    fechaVto: '07-07-2026',
    importe: 35121.37,
    saldo: 35121.37,
    urlPdf: 'https://pdf',
    cuponPdf: 'https://cupon',
    paymentUrl: 'https://mp',
    ...overrides,
  };
}

const CLIENT = '100011';
// Fixed clock: 2026-07-07 09:00 AR → today(AR) = 2026-07-07.
const at = new Date('2026-07-07T12:00:00Z');

describe('InMemoryClientMirrorRepository.upsertInvoices', () => {
  let repo: InMemoryClientMirrorRepository;

  beforeEach(() => {
    repo = new InMemoryClientMirrorRepository();
  });

  function invoicesFor(clientId: string) {
    return repo.invoices.filter((r) => r.clientId === clientId);
  }

  it('creates GR invoices for the client', async () => {
    await repo.upsertInvoices(CLIENT, [makeGrInvoice('A'), makeGrInvoice('B')], at);
    const rows = invoicesFor(CLIENT);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.grInvoiceId).sort()).toEqual(['FB-00010-A', 'FB-00010-B']);
  });

  it('re-upsert updates the balance and derived status of an existing invoice', async () => {
    await repo.upsertInvoices(CLIENT, [makeGrInvoice('A', { saldo: 35121.37 })], at);
    // Now GR returns the same invoice paid off (saldo 0).
    await repo.upsertInvoices(CLIENT, [makeGrInvoice('A', { saldo: 0 })], at);
    const rows = invoicesFor(CLIENT);
    expect(rows).toHaveLength(1);
    expect(rows[0].balance).toBe(0);
    expect(rows[0].status).toBe('pagada');
  });

  it('mirror: an invoice GR no longer returns is DELETED (paid → disappears)', async () => {
    await repo.upsertInvoices(CLIENT, [makeGrInvoice('A'), makeGrInvoice('B'), makeGrInvoice('C')], at);
    // GR now returns only A and B (C was paid).
    await repo.upsertInvoices(CLIENT, [makeGrInvoice('A'), makeGrInvoice('B')], at);
    const ids = invoicesFor(CLIENT).map((r) => r.grInvoiceId).sort();
    expect(ids).toEqual(['FB-00010-A', 'FB-00010-B']);
  });

  it('empty invoices deletes ALL of the client GR invoices', async () => {
    await repo.upsertInvoices(CLIENT, [makeGrInvoice('A'), makeGrInvoice('B')], at);
    await repo.upsertInvoices(CLIENT, [], at);
    expect(invoicesFor(CLIENT)).toHaveLength(0);
  });

  it('NEVER deletes a manual invoice (grInvoiceId = null)', async () => {
    // Plant a manual invoice directly.
    repo.invoices.push({
      clientId: CLIENT,
      grInvoiceId: null,
      number: 'MANUAL-1',
      grType: null,
      currency: 'ARS',
      amount: 1000,
      balance: 1000,
      issueDate: at,
      dueDate: at,
      status: 'pendiente',
      pdfUrl: null,
      couponPdfUrl: null,
      paymentUrl: null,
    });
    // GR returns [] — should delete GR invoices only, keep the manual one.
    await repo.upsertInvoices(CLIENT, [makeGrInvoice('A')], at);
    await repo.upsertInvoices(CLIENT, [], at);
    const rows = invoicesFor(CLIENT);
    expect(rows).toHaveLength(1);
    expect(rows[0].grInvoiceId).toBeNull();
    expect(rows[0].number).toBe('MANUAL-1');
  });

  it('does not touch another client invoices', async () => {
    await repo.upsertInvoices(CLIENT, [makeGrInvoice('A')], at);
    await repo.upsertInvoices('999', [makeGrInvoice('Z')], at);
    // Re-sync CLIENT with empty → only CLIENT invoices are removed.
    await repo.upsertInvoices(CLIENT, [], at);
    expect(invoicesFor(CLIENT)).toHaveLength(0);
    expect(invoicesFor('999')).toHaveLength(1);
  });
});
