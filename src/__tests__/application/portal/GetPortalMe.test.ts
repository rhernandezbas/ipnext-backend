/**
 * customer-portal-api (Fase 4, task 4.1) — GetPortalMe.
 *
 * fix/portal-balance-from-invoices — el saldo se calcula sobre `Invoice`
 * (Prominense), NUNCA sobre `Client.balanceDue` (agregado de GR). Ver
 * `GetPortalMe.ts` / `domain/ports/CustomerRepository.ts` (`PortalBalanceSummary`)
 * para el porque (medido en prod con HERNANDEZ RONALD: GR decia `balanceDue = 0`
 * con 5 facturas vencidas por $100.886,90).
 *
 * Fake CustomerRepository INLINE MINIMO (convencion del repo — ver
 * messagingBulk.routes.test.ts / ReceiveChatwootWebhook.optout.test.ts: "NO un
 * InMemoryCustomerRepository completo", no existe un adapter in-memory compartido
 * para este port). `getPortalBalanceSummary` reproduce EN MEMORIA el mismo
 * contrato que `PrismaCustomerRepository.getPortalBalanceSummary` (mismo criterio
 * que cualquier adapter in-memory: implementa el PORT, no reusa el codigo Prisma).
 */
import { GetPortalMe } from '@application/use-cases/portal/GetPortalMe';
import { ListPortalInvoices } from '@application/use-cases/portal/ListPortalInvoices';
import { Customer } from '@domain/entities/customer';
import { Invoice } from '@domain/entities/billing';
import { ClientNotFoundError } from '@domain/errors';
import type { CustomerRepository, PortalBalanceSummary } from '@domain/ports/CustomerRepository';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'client-a',
    name: 'Ana Cliente',
    email: 'ana@example.com',
    phone: '1155551234',
    status: 'active',
    address: 'Calle Falsa 123',
    city: 'CABA',
    country: 'AR',
    login: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    // Campos GR: seedeados con valores INCORRECTOS/mentirosos a proposito en
    // varios tests (revert-probe) — GetPortalMe NUNCA debe leerlos.
    balanceDue: null,
    balanceCurrency: null,
    lastBalanceAt: null,
    ...overrides,
  };
}

/** `Invoice` de dominio + `createdAt` (marca de frescura, NO expuesta por `listInvoices`). */
interface FixtureInvoice extends Invoice {
  createdAt: string;
}

function makeInvoice(overrides: Partial<FixtureInvoice> = {}): FixtureInvoice {
  return {
    id: overrides.id ?? 'inv-1',
    number: 'F-0001',
    customerId: 'client-a',
    customerName: 'Ana Cliente',
    issueDate: '2026-06-01T00:00:00.000Z',
    dueDate: '2026-06-15T00:00:00.000Z',
    amount: 1000,
    status: 'pendiente',
    lineItems: [],
    grInvoiceId: 'FB-1-1',
    balance: 1000,
    grType: 'FB',
    currency: 'ARS',
    pdfUrl: null,
    couponPdfUrl: null,
    paymentUrl: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

class FakeCustomerRepository implements Partial<CustomerRepository> {
  private customers = new Map<string, Customer>();
  private invoicesByClient = new Map<string, FixtureInvoice[]>();

  seed(customer: Customer): void {
    this.customers.set(customer.id, customer);
  }

  seedInvoices(clientId: string, invoices: FixtureInvoice[]): void {
    this.invoicesByClient.set(clientId, invoices);
  }

  async findById(id: string): Promise<Customer> {
    const c = this.customers.get(id);
    if (!c) throw new ClientNotFoundError(id);
    return c;
  }

  async listInvoices(clientId: string): Promise<Invoice[]> {
    return (this.invoicesByClient.get(clientId) ?? []).map(({ createdAt: _createdAt, ...invoice }) => invoice);
  }

  async getPortalBalanceSummary(clientId: string): Promise<PortalBalanceSummary | null> {
    const invoices = this.invoicesByClient.get(clientId) ?? [];
    if (invoices.length === 0) return null; // sin facturas espejadas -> "sin datos"

    const unpaid = invoices.filter((i) => i.status !== 'pagada');
    const unpaidBalance = unpaid.reduce((sum, i) => sum + (i.balance ?? 0), 0);

    // Frescura del numero mostrado: max(createdAt) de las impagas consideradas;
    // si no hay impagas (todo pagado), max(createdAt) de TODAS las facturas.
    const freshnessSource = unpaid.length > 0 ? unpaid : invoices;
    const lastUpdatedAt = freshnessSource.reduce<string | null>(
      (latest, inv) => (!latest || inv.createdAt > latest ? inv.createdAt : latest),
      null,
    );

    const mostRecentOverall = invoices.reduce((latest, inv) =>
      inv.createdAt > latest.createdAt ? inv : latest,
    );

    return {
      unpaidBalance,
      currency: mostRecentOverall.currency ?? null,
      lastUpdatedAt,
    };
  }
}

describe('GetPortalMe — customer-portal-api Fase 4.1 (saldo calculado local, fix/portal-balance-from-invoices)', () => {
  it('cliente con facturas (3 vencidas + 1 pendiente + 1 pagada): balance = suma de las 4 impagas, la pagada NO suma', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a', name: 'Hernandez Ronald', status: 'active' }));
    repo.seedInvoices('client-a', [
      makeInvoice({ id: 'v1', status: 'vencida', balance: 20000, currency: 'ARS', createdAt: '2026-05-01T00:00:00.000Z' }),
      makeInvoice({ id: 'v2', status: 'vencida', balance: 30000, currency: 'ARS', createdAt: '2026-06-01T00:00:00.000Z' }),
      makeInvoice({ id: 'v3', status: 'vencida', balance: 25886.9, currency: 'ARS', createdAt: '2026-06-15T00:00:00.000Z' }),
      makeInvoice({ id: 'p1', status: 'pendiente', balance: 25000, currency: 'ARS', createdAt: '2026-07-01T00:00:00.000Z' }),
      // pagada MAS reciente que las impagas — no debe filtrar ni al balance ni a la fecha.
      makeInvoice({ id: 'pg', status: 'pagada', balance: 0, currency: 'ARS', createdAt: '2026-07-20T00:00:00.000Z' }),
    ]);
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result.name).toBe('Hernandez Ronald');
    expect(result.status).toBe('active');
    expect(result.balance).toBeCloseTo(100886.9, 2);
    expect(result.balanceCurrency).toBe('ARS');
    // frescura = la impaga mas reciente (07-01), NO la pagada del 07-20.
    expect(result.lastBalanceAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('cliente con TODAS las facturas pagadas: balance 0 (al dia) + moneda coherente', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a' }));
    repo.seedInvoices('client-a', [
      makeInvoice({ id: 'pg1', status: 'pagada', balance: 0, currency: 'ARS', createdAt: '2026-06-01T00:00:00.000Z' }),
      makeInvoice({ id: 'pg2', status: 'pagada', balance: 0, currency: 'ARS', createdAt: '2026-07-01T00:00:00.000Z' }),
    ]);
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result.balance).toBe(0);
    expect(result.balance).not.toBeNull();
    expect(result.balanceCurrency).toBe('ARS');
    // sin impagas -> fallback a la mas reciente overall.
    expect(result.lastBalanceAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('scenario "Cliente sin facturas espejadas": balance null (NUNCA 0)', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a' })); // sin seedInvoices
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result.balance).toBeNull();
    expect(result.balance).not.toBe(0);
    expect(result.balanceCurrency).toBeNull();
    expect(result.lastBalanceAt).toBeNull();
  });

  // REVERT-PROBE: reproduce el bug medido en prod (HERNANDEZ RONALD). Con el
  // codigo VIEJO (`client.balanceDue ?? null`) este test da `balance: 0` y
  // FALLA — es la prueba de que el fix esta protegido contra el regreso al
  // agregado de GR.
  it('REGRESSION: ignora Client.balanceDue de GR (mentiroso) — usa el saldo calculado de las facturas', async () => {
    const repo = new FakeCustomerRepository();
    // GR dice balanceDue=0 (como en prod) pero hay una factura vencida sin pagar.
    repo.seed(makeCustomer({ id: 'client-a', balanceDue: 0, balanceCurrency: 'ARS', lastBalanceAt: '2026-01-01T00:00:00.000Z' }));
    repo.seedInvoices('client-a', [
      makeInvoice({ id: 'v1', status: 'vencida', balance: 100886.9, currency: 'ARS', createdAt: '2026-07-01T00:00:00.000Z' }),
    ]);
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result.balance).toBeCloseTo(100886.9, 2);
    expect(result.balance).not.toBe(0);
  });

  // anti-contradiccion (spec "el saldo NUNCA contradice la lista de facturas"):
  // mismo fixture consumido por GetPortalMe y ListPortalInvoices — la suma de
  // los `balance` no-pagados del listado tiene que ser IGUAL al `balance` de /me.
  it('anti-contradiccion: balance de /me == suma de balance no-pagado de ListPortalInvoices', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a' }));
    repo.seedInvoices('client-a', [
      makeInvoice({ id: 'v1', status: 'vencida', balance: 20000 }),
      makeInvoice({ id: 'v2', status: 'vencida', balance: 30000 }),
      makeInvoice({ id: 'p1', status: 'pendiente', balance: 25000 }),
      makeInvoice({ id: 'pg', status: 'pagada', balance: 0 }),
    ]);
    const getPortalMe = new GetPortalMe(repo as unknown as CustomerRepository);
    const listPortalInvoices = new ListPortalInvoices(repo as unknown as CustomerRepository);

    const me = await getPortalMe.execute('client-a');
    const invoicesPage = await listPortalInvoices.execute('client-a', {});

    const sumFromList = invoicesPage.data
      .filter((i) => i.status !== 'pagada')
      .reduce((sum, i) => sum + (i.balance ?? 0), 0);

    expect(me.balance).toBe(sumFromList);
    expect(me.balance).toBe(75000);
  });

  // anti-IDOR (spec 4.5): dos clientes seedeados, cada llamada ve SOLO el
  // balance calculado sobre SUS PROPIAS facturas.
  it('anti-IDOR: dos clientes seedeados, cada balance ve SOLO sus propias facturas', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a', name: 'Cliente A' }));
    repo.seed(makeCustomer({ id: 'client-b', name: 'Cliente B' }));
    repo.seedInvoices('client-a', [makeInvoice({ id: 'a1', status: 'vencida', balance: 100 })]);
    repo.seedInvoices('client-b', [makeInvoice({ id: 'b1', status: 'vencida', balance: 200 })]);
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const a = await useCase.execute('client-a');
    const b = await useCase.execute('client-b');

    expect(a.name).toBe('Cliente A');
    expect(a.balance).toBe(100);
    expect(b.name).toBe('Cliente B');
    expect(b.balance).toBe(200);
  });
});
