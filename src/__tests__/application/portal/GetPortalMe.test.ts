/**
 * customer-portal-api (Fase 4, task 4.1) — GetPortalMe.
 *
 * fix/portal-balance-from-invoices — el saldo se calcula sobre `Invoice`
 * (Prominense), NUNCA sobre `Client.balanceDue` (agregado de GR). Ver
 * `GetPortalMe.ts` / `domain/ports/CustomerRepository.ts` (`PortalBalanceSummary`)
 * para el porque (medido en prod con HERNANDEZ RONALD: GR decia `balanceDue = 0`
 * con 5 facturas vencidas por $100.886,90).
 *
 * fix wave (multi-moneda) — medido en prod: `Invoice.currency` tiene `PES`
 * (7430 filas) y `DOL` (43 filas, códigos de GR, NO ISO 4217) — hay 4 clientes
 * con facturas en las dos monedas y 3 de ellos con IMPAGAS en las dos al
 * mismo tiempo. Sumar todo en un `balance` único mezclaba pesos con dólares
 * (basura). `GetPortalMe` ahora expone `balances: PortalBalanceEntryDto[]`,
 * una entrada POR MONEDA ISO, JAMÁS una suma cruzada.
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
import { normalizeGrCurrency } from '@domain/services/normalizeGrCurrency';
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

  /**
   * fix wave (multi-moneda) — mismo contrato que
   * `PrismaCustomerRepository.getPortalBalanceSummary`: agrupa las impagas
   * por moneda ISO normalizada (`normalizeGrCurrency`), JAMÁS suma monedas
   * distintas en un único número.
   */
  async getPortalBalanceSummary(clientId: string): Promise<PortalBalanceSummary | null> {
    const invoices = this.invoicesByClient.get(clientId) ?? [];
    if (invoices.length === 0) return null; // sin facturas espejadas -> "sin datos"

    const unpaid = invoices.filter((i) => i.status !== 'pagada');
    const mostRecentOverall = invoices.reduce((latest, inv) =>
      inv.createdAt > latest.createdAt ? inv : latest,
    );

    if (unpaid.length === 0) {
      return {
        balances: [{ currency: normalizeGrCurrency(mostRecentOverall.currency) ?? 'DESCONOCIDA', amount: 0 }],
        lastUpdatedAt: mostRecentOverall.createdAt,
      };
    }

    const merged = new Map<string, number>();
    let unknownAmount: number | null = null;
    for (const inv of unpaid) {
      const iso = normalizeGrCurrency(inv.currency);
      const amount = inv.balance ?? 0;
      if (iso === null) {
        unknownAmount = (unknownAmount ?? 0) + amount;
        continue;
      }
      merged.set(iso, (merged.get(iso) ?? 0) + amount);
    }
    if (unknownAmount !== null) {
      const label = merged.size === 0 ? 'ARS' : 'DESCONOCIDA';
      merged.set(label, (merged.get(label) ?? 0) + unknownAmount);
    }

    const balances = Array.from(merged.entries())
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => b.amount - a.amount);

    const lastUpdatedAt = unpaid.reduce<string | null>(
      (latest, inv) => (!latest || inv.createdAt > latest ? inv.createdAt : latest),
      null,
    ) as string;

    return { balances, lastUpdatedAt };
  }
}

describe('GetPortalMe — customer-portal-api Fase 4.1 (saldo por moneda, fix/portal-balance-from-invoices)', () => {
  it('cliente con facturas (3 vencidas + 1 pendiente + 1 pagada), UNA sola moneda: balances = [{currency, amount}] con la suma de las 4 impagas, la pagada NO suma', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a', name: 'Hernandez Ronald', status: 'active' }));
    repo.seedInvoices('client-a', [
      makeInvoice({ id: 'v1', status: 'vencida', balance: 20000, currency: 'PES', createdAt: '2026-05-01T00:00:00.000Z' }),
      makeInvoice({ id: 'v2', status: 'vencida', balance: 30000, currency: 'PES', createdAt: '2026-06-01T00:00:00.000Z' }),
      makeInvoice({ id: 'v3', status: 'vencida', balance: 25886.9, currency: 'PES', createdAt: '2026-06-15T00:00:00.000Z' }),
      makeInvoice({ id: 'p1', status: 'pendiente', balance: 25000, currency: 'PES', createdAt: '2026-07-01T00:00:00.000Z' }),
      // pagada MAS reciente que las impagas — no debe filtrar ni al balance ni a la fecha.
      makeInvoice({ id: 'pg', status: 'pagada', balance: 0, currency: 'PES', createdAt: '2026-07-20T00:00:00.000Z' }),
    ]);
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result.name).toBe('Hernandez Ronald');
    expect(result.status).toBe('active');
    expect(result.balances).toEqual([{ currency: 'ARS', amount: 100886.9 }]);
    // frescura = la impaga mas reciente (07-01), NO la pagada del 07-20.
    expect(result.lastBalanceAt).toBe('2026-07-01T00:00:00.000Z');
  });

  // El test que reproduce el bug medido en prod: sumar monedas distintas es basura.
  it('MULTI-MONEDA: cliente con impagas en PES y DOL -> DOS entradas (ARS/USD), ordenadas por amount DESC, NUNCA una suma cruzada', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a', name: 'Cliente Bimonetario' }));
    repo.seedInvoices('client-a', [
      makeInvoice({ id: 'ars1', status: 'vencida', balance: 20000, currency: 'PES', createdAt: '2026-06-01T00:00:00.000Z' }),
      makeInvoice({ id: 'usd1', status: 'vencida', balance: 50, currency: 'DOL', createdAt: '2026-07-01T00:00:00.000Z' }),
    ]);
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result.balances).toEqual([
      { currency: 'ARS', amount: 20000 },
      { currency: 'USD', amount: 50 },
    ]);
    expect(result.balances).not.toBeNull();
    expect(result.balances?.length).toBe(2);
    // Anti-basura: NINGUN escenario junta ambos montos en un solo numero.
    expect(result.balances?.map((b) => b.amount)).not.toContain(20050);
  });

  it('cliente con TODAS las facturas pagadas: balances = [{currency, amount: 0}] (al dia) + moneda coherente', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a' }));
    repo.seedInvoices('client-a', [
      makeInvoice({ id: 'pg1', status: 'pagada', balance: 0, currency: 'PES', createdAt: '2026-06-01T00:00:00.000Z' }),
      makeInvoice({ id: 'pg2', status: 'pagada', balance: 0, currency: 'PES', createdAt: '2026-07-01T00:00:00.000Z' }),
    ]);
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result.balances).toEqual([{ currency: 'ARS', amount: 0 }]);
    expect(result.balances).not.toBeNull();
    // sin impagas -> fallback a la mas reciente overall.
    expect(result.lastBalanceAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('scenario "Cliente sin facturas espejadas": balances null (NUNCA [])', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a' })); // sin seedInvoices
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result.balances).toBeNull();
    expect(result.lastBalanceAt).toBeNull();
  });

  it('DOL -> USD; codigo raro (XYZ) pasa crudo en mayusculas', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a' }));
    repo.seedInvoices('client-a', [
      makeInvoice({ id: 'v1', status: 'vencida', balance: 100, currency: 'XYZ', createdAt: '2026-07-01T00:00:00.000Z' }),
    ]);
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result.balances).toEqual([{ currency: 'XYZ', amount: 100 }]);
  });

  // REVERT-PROBE: reproduce el bug medido en prod (HERNANDEZ RONALD). Con el
  // codigo VIEJO (`client.balanceDue ?? null`) este test da `balances: null`
  // (porque el DTO viejo ni siquiera tiene el campo `balances`) y FALLA — es
  // la prueba de que el fix esta protegido contra el regreso al agregado de GR.
  it('REGRESSION: ignora Client.balanceDue de GR (mentiroso) — usa el saldo calculado de las facturas', async () => {
    const repo = new FakeCustomerRepository();
    // GR dice balanceDue=0 (como en prod) pero hay una factura vencida sin pagar.
    repo.seed(makeCustomer({ id: 'client-a', balanceDue: 0, balanceCurrency: 'ARS', lastBalanceAt: '2026-01-01T00:00:00.000Z' }));
    repo.seedInvoices('client-a', [
      makeInvoice({ id: 'v1', status: 'vencida', balance: 100886.9, currency: 'PES', createdAt: '2026-07-01T00:00:00.000Z' }),
    ]);
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result.balances).toEqual([{ currency: 'ARS', amount: 100886.9 }]);
    expect(result.balances?.[0]?.amount).not.toBe(0);
  });

  // anti-contradiccion (spec "el saldo NUNCA contradice la lista de facturas"):
  // mismo fixture consumido por GetPortalMe y ListPortalInvoices — ambos leen
  // de `CustomerRepository.listInvoices` (la lista NUNCA expone `currency` en
  // su DTO de wire, pero es la MISMA fuente de datos cruda que agrupa
  // `getPortalBalanceSummary`). La suma por moneda de esa fuente cruda tiene
  // que ser IGUAL a la entrada de esa moneda en `/me` — si no coincidiera,
  // el número de arriba (`/me`) contradiría la lista de abajo.
  it('anti-contradiccion: cada entrada de balances de /me == suma por-moneda de las mismas facturas que lista ListPortalInvoices', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a' }));
    repo.seedInvoices('client-a', [
      makeInvoice({ id: 'v1', status: 'vencida', balance: 20000, currency: 'PES' }),
      makeInvoice({ id: 'v2', status: 'vencida', balance: 30000, currency: 'PES' }),
      makeInvoice({ id: 'p1', status: 'pendiente', balance: 25000, currency: 'PES' }),
      makeInvoice({ id: 'usd1', status: 'vencida', balance: 10, currency: 'DOL' }),
      makeInvoice({ id: 'pg', status: 'pagada', balance: 0, currency: 'PES' }),
    ]);
    const getPortalMe = new GetPortalMe(repo as unknown as CustomerRepository);
    const listPortalInvoices = new ListPortalInvoices(repo as unknown as CustomerRepository);

    const me = await getPortalMe.execute('client-a');
    const invoicesPage = await listPortalInvoices.execute('client-a', {});
    // Misma fuente que consume ListPortalInvoices (`repo.listInvoices`),
    // filtrada por status igual que el DTO de arriba (garantiza que estamos
    // mirando EL MISMO universo de facturas que la lista, no otro).
    const rawInvoices = await repo.listInvoices('client-a');
    expect(invoicesPage.data.length).toBe(rawInvoices.length);

    const sumByCurrency = new Map<string, number>();
    for (const inv of rawInvoices.filter((i) => i.status !== 'pagada')) {
      const iso = normalizeGrCurrency(inv.currency) ?? 'ARS';
      sumByCurrency.set(iso, (sumByCurrency.get(iso) ?? 0) + (inv.balance ?? 0));
    }

    expect(me.balances).toEqual([
      { currency: 'ARS', amount: sumByCurrency.get('ARS') },
      { currency: 'USD', amount: sumByCurrency.get('USD') },
    ]);
    expect(sumByCurrency.get('ARS')).toBe(75000);
    expect(sumByCurrency.get('USD')).toBe(10);
  });

  // customer-balance-unmask (Fase 3, tarea 3.11) — spec customer-balance-truth,
  // requirement "portal self-service balance is untouched". Antes del unmask,
  // un `Customer.balanceDue:99999` en un cliente `active` sin `late` era
  // IMPOSIBLE de producir (el mapper lo pisaba a 0) — post-unmask es un
  // resultado normal para cualquier cliente con deuda real. Este pin prueba
  // que, sea cual sea el valor de `Client.balanceDue` en la fila, GetPortalMe
  // JAMÁS lo filtra al portal: solo lee `name`/`status` del Customer
  // (GetPortalMe.ts:38-39) — los campos de plata SIEMPRE salen de
  // `getPortalBalanceSummary` (facturas), nunca de `toCustomer`.
  it('pin post-unmask: findById devuelve balanceDue:99999 (producible ahora) pero getPortalBalanceSummary da null — balances sigue null, el 99999 NUNCA se filtra', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a', status: 'active', balanceDue: 99999, balanceCurrency: 'ARS' }));
    // sin seedInvoices — getPortalBalanceSummary da null ("sin facturas espejadas").
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result.balances).toBeNull();
    expect(JSON.stringify(result)).not.toContain('99999');
  });

  // anti-IDOR (spec 4.5): dos clientes seedeados, cada llamada ve SOLO el
  // balance calculado sobre SUS PROPIAS facturas.
  it('anti-IDOR: dos clientes seedeados, cada balance ve SOLO sus propias facturas', async () => {
    const repo = new FakeCustomerRepository();
    repo.seed(makeCustomer({ id: 'client-a', name: 'Cliente A' }));
    repo.seed(makeCustomer({ id: 'client-b', name: 'Cliente B' }));
    repo.seedInvoices('client-a', [makeInvoice({ id: 'a1', status: 'vencida', balance: 100, currency: 'PES' })]);
    repo.seedInvoices('client-b', [makeInvoice({ id: 'b1', status: 'vencida', balance: 200, currency: 'PES' })]);
    const useCase = new GetPortalMe(repo as unknown as CustomerRepository);

    const a = await useCase.execute('client-a');
    const b = await useCase.execute('client-b');

    expect(a.name).toBe('Cliente A');
    expect(a.balances).toEqual([{ currency: 'ARS', amount: 100 }]);
    expect(b.name).toBe('Cliente B');
    expect(b.balances).toEqual([{ currency: 'ARS', amount: 200 }]);
  });
});
