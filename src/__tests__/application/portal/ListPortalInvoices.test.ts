/**
 * customer-portal-api (Fase 4, task 4.2) — ListPortalInvoices.
 *
 * portal-self-service spec "Mis facturas": DTO sin campos internos, orden
 * issueDate desc, paginado. Fake CustomerRepository inline minimo (misma
 * convencion que GetPortalMe.test.ts).
 */
import { ListPortalInvoices } from '@application/use-cases/portal/ListPortalInvoices';
import { Invoice } from '@domain/entities/billing';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';

function makeInvoice(overrides: Partial<Invoice>): Invoice {
  return {
    id: overrides.id ?? 'inv-1',
    number: 'F-0001',
    customerId: 'client-a',
    customerName: 'Ana Cliente',
    issueDate: '2026-01-01T00:00:00.000Z',
    dueDate: '2026-01-15T00:00:00.000Z',
    amount: 1000,
    status: 'pendiente',
    lineItems: [{ description: 'Internet', quantity: 1, unitPrice: 1000, total: 1000 }],
    grInvoiceId: 'FB-1-1',
    balance: 500,
    grType: 'FB',
    currency: 'PES',
    pdfUrl: 'https://example.com/f1.pdf',
    couponPdfUrl: null,
    paymentUrl: 'https://example.com/pay/f1',
    ...overrides,
  };
}

class FakeCustomerRepository implements Partial<CustomerRepository> {
  private invoicesByClient = new Map<string, Invoice[]>();

  seedInvoices(clientId: string, invoices: Invoice[]): void {
    this.invoicesByClient.set(clientId, invoices);
  }

  async listInvoices(clientId: string): Promise<Invoice[]> {
    return this.invoicesByClient.get(clientId) ?? [];
  }
}

describe('ListPortalInvoices — customer-portal-api Fase 4.2', () => {
  it('mapea al DTO sin lineItems/grInvoiceId y con paymentUrl/pdfUrl', async () => {
    const repo = new FakeCustomerRepository();
    repo.seedInvoices('client-a', [makeInvoice({ id: 'inv-1', number: 'F-0001' })]);
    const useCase = new ListPortalInvoices(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a', {});

    expect(result.data).toEqual([
      {
        number: 'F-0001',
        issueDate: '2026-01-01T00:00:00.000Z',
        dueDate: '2026-01-15T00:00:00.000Z',
        amount: 1000,
        balance: 500,
        status: 'pendiente',
        pdfUrl: 'https://example.com/f1.pdf',
        paymentUrl: 'https://example.com/pay/f1',
      },
    ]);
    expect((result.data[0] as unknown as { lineItems?: unknown }).lineItems).toBeUndefined();
    expect((result.data[0] as unknown as { grInvoiceId?: unknown }).grInvoiceId).toBeUndefined();
  });

  it('scenario "Cliente consulta sus facturas": orden issueDate desc', async () => {
    const repo = new FakeCustomerRepository();
    repo.seedInvoices('client-a', [
      makeInvoice({ id: 'old', number: 'F-0001', issueDate: '2026-01-01T00:00:00.000Z' }),
      makeInvoice({ id: 'new', number: 'F-0003', issueDate: '2026-03-01T00:00:00.000Z' }),
      makeInvoice({ id: 'mid', number: 'F-0002', issueDate: '2026-02-01T00:00:00.000Z' }),
    ]);
    const useCase = new ListPortalInvoices(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a', {});

    expect(result.data.map((i) => i.number)).toEqual(['F-0003', 'F-0002', 'F-0001']);
  });

  it('paginado: page/limit recortan y total refleja el universo completo', async () => {
    const repo = new FakeCustomerRepository();
    repo.seedInvoices('client-a', [
      makeInvoice({ id: '1', number: 'F-1', issueDate: '2026-01-01T00:00:00.000Z' }),
      makeInvoice({ id: '2', number: 'F-2', issueDate: '2026-01-02T00:00:00.000Z' }),
      makeInvoice({ id: '3', number: 'F-3', issueDate: '2026-01-03T00:00:00.000Z' }),
    ]);
    const useCase = new ListPortalInvoices(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a', { page: 1, limit: 2 });

    expect(result.total).toBe(3);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(2);
    expect(result.data.map((i) => i.number)).toEqual(['F-3', 'F-2']);
  });

  it('anti-IDOR: dos clientes seedeados, cada llamada ve SOLO sus propias facturas', async () => {
    const repo = new FakeCustomerRepository();
    repo.seedInvoices('client-a', [makeInvoice({ id: 'a1', number: 'A-1' })]);
    repo.seedInvoices('client-b', [makeInvoice({ id: 'b1', number: 'B-1' }), makeInvoice({ id: 'b2', number: 'B-2' })]);
    const useCase = new ListPortalInvoices(repo as unknown as CustomerRepository);

    const a = await useCase.execute('client-a', {});
    const b = await useCase.execute('client-b', {});

    expect(a.data.map((i) => i.number)).toEqual(['A-1']);
    expect(b.data.map((i) => i.number).sort()).toEqual(['B-1', 'B-2']);
  });
});
