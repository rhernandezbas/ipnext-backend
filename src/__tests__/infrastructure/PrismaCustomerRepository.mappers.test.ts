import {
  toCustomer,
  toService,
  toClientLog,
  toInvoice,
  toActiveClientContact,
  toPortalBalanceSummary,
} from '../../infrastructure/adapters/prisma/PrismaCustomerRepository';
import { CustomerStatus } from '../../domain/entities/customer';

describe('PrismaCustomerRepository mappers', () => {
  describe('toCustomer', () => {
    it('maps a full row into a Customer entity', () => {
      const row = {
        id: 'c-1',
        name: 'Juan García',
        email: 'juan@example.com',
        phone: '+54 911 5550-0001',
        status: 'active',
        address: 'Av. Corrientes 1234',
        city: 'Buenos Aires',
        country: 'Argentina',
        login: 'jgarcia',
        createdAt: new Date('2026-01-01T10:00:00Z'),
        customAttributes: null,
      };
      const c = toCustomer(row);
      expect(c).toEqual({
        id: 'c-1',
        grClienteId: null,
        name: 'Juan García',
        email: 'juan@example.com',
        phone: '+54 911 5550-0001',
        status: 'active',
        address: 'Av. Corrientes 1234',
        city: 'Buenos Aires',
        country: 'Argentina',
        login: 'jgarcia',
        createdAt: '2026-01-01T10:00:00.000Z',
        customAttributes: undefined,
        // Balance fields — active client: 0 balance, not stale
        balanceDue: 0,
        balanceCurrency: null,
        lastBalanceAt: null,
        balanceStale: false,
        // client-geolocation: Prominense-owned GPS (null cuando el row no los trae)
        lat: null,
        lng: null,
        plusCode: null,
      });
    });

    it('surfaces a stored "baja" status as status: "baja"', () => {
      const c = toCustomer({
        id: 'c-baja',
        name: 'Cliente Baja',
        email: 'baja@example.com',
        phone: '0',
        status: 'baja',
        login: 'cbaja',
        address: null,
        city: null,
        country: null,
        createdAt: '2026-03-01T00:00:00.000Z',
      });
      // Runtime: the mapper passes the GR mirror status through verbatim.
      expect(c.status).toBe('baja');
      // Type honesty: 'baja' must be assignable to CustomerStatus. With the
      // narrow union (no 'baja') this assignment fails to compile.
      const status: CustomerStatus = c.status;
      const baja: CustomerStatus = 'baja';
      expect(status).toBe(baja);
    });

    it('defaults missing nullable strings to empty', () => {
      const c = toCustomer({
        id: 'c-2', name: 'X', email: 'x@x.com', phone: '0',
        status: 'inactive', login: 'x',
        address: null, city: null, country: null,
        createdAt: '2026-02-01T00:00:00.000Z',
      });
      expect(c.address).toBe('');
      expect(c.city).toBe('');
      expect(c.country).toBe('');
    });
  });

  describe('toService', () => {
    it('maps a Service row, defaulting endDate to empty when null', () => {
      const s = toService({
        id: 's-1',
        type: 'internet',
        plan: 'Fibra 300',
        ip: '192.168.1.1',
        status: 'active',
        startDate: new Date('2024-01-01T00:00:00Z'),
        endDate: null,
      });
      expect(s.endDate).toBe('');
      expect(s.startDate).toBe('2024-01-01T00:00:00.000Z');
      expect(s.ip).toBe('192.168.1.1');
    });

    // #42 DEBT — the Contract model HAS `technology` but the mapper dropped it,
    // making it a dead field in the FE ContractCard + buildContractLabel.
    it('maps the contract technology (#42 debt)', () => {
      const s = toService({
        id: 's-2',
        type: 'internet',
        plan: 'Fibra 300',
        ip: '10.0.0.1',
        status: 'active',
        startDate: new Date('2024-01-01T00:00:00Z'),
        endDate: null,
        technology: 'FIBRA',
      });
      expect(s.technology).toBe('FIBRA');
    });

    it('preserves a null technology (#42 debt)', () => {
      const s = toService({
        id: 's-3',
        type: 'internet',
        plan: 'Plan X',
        ip: '',
        status: 'active',
        startDate: new Date('2024-01-01T00:00:00Z'),
        endDate: null,
        technology: null,
      });
      expect(s.technology).toBeNull();
    });
  });

  describe('toClientLog', () => {
    it('maps a ClientLog row', () => {
      const log = toClientLog({
        id: 'l-1',
        timestamp: new Date('2026-05-01T12:00:00Z'),
        eventType: 'payment',
        description: 'Pago factura #1',
      });
      expect(log).toEqual({
        id: 'l-1',
        timestamp: '2026-05-01T12:00:00.000Z',
        eventType: 'payment',
        description: 'Pago factura #1',
      });
    });
  });

  describe('toInvoice', () => {
    it('maps invoice with Prisma Decimal-like amount', () => {
      const fakeDecimal = { toNumber: () => 4500 };
      const inv = toInvoice({
        id: 'inv-1',
        number: 'FAC-001',
        clientId: 'c-1',
        customerName: 'Juan',
        issueDate: new Date('2026-04-01T00:00:00Z'),
        dueDate: new Date('2026-04-15T00:00:00Z'),
        amount: fakeDecimal,
        status: 'pagada',
        lineItems: [{ description: 'Fibra', quantity: 1, unitPrice: 4500, total: 4500 }],
      });
      expect(inv.amount).toBe(4500);
      expect(inv.customerId).toBe('c-1');
      expect(inv.lineItems).toHaveLength(1);
    });

    it('coerces non-array lineItems to []', () => {
      const inv = toInvoice({
        id: 'inv-2', number: 'F-2', clientId: 'c-2', customerName: 'Y',
        issueDate: '2026-04-01', dueDate: '2026-04-15',
        amount: 100, status: 'pendiente',
        lineItems: null,
      });
      expect(inv.lineItems).toEqual([]);
    });
  });

  // recapture-active-client-match batch 1 — narrow candidate-contact mapper
  // for CustomerRepository.listActiveContacts() (design.md Decisión 1).
  describe('toActiveClientContact', () => {
    it('maps a full row into an ActiveClientContact', () => {
      const contact = toActiveClientContact({
        id: 'c-active-1',
        name: 'Ana Activa',
        phone: '2324-421234',
        email: 'ana@example.com',
      });
      expect(contact).toEqual({
        id: 'c-active-1',
        name: 'Ana Activa',
        phone: '2324-421234',
        email: 'ana@example.com',
      });
    });

    it('preserves a null phone (defensive — Client.phone is non-null in schema, but stay honest)', () => {
      const contact = toActiveClientContact({
        id: 'c-active-2',
        name: 'Sin Telefono',
        phone: null,
        email: 'notel@example.com',
      });
      expect(contact.phone).toBeNull();
      expect(contact.email).toBe('notel@example.com');
    });

    it('preserves a null email', () => {
      const contact = toActiveClientContact({
        id: 'c-active-3',
        name: 'Sin Email',
        phone: '111-2222',
        email: null,
      });
      expect(contact.email).toBeNull();
      expect(contact.phone).toBe('111-2222');
    });

    it('coerces undefined phone/email to null (never leaks undefined into the DTO)', () => {
      const contact = toActiveClientContact({
        id: 'c-active-4',
        name: 'Undefined Fields',
        phone: undefined,
        email: undefined,
      });
      expect(contact.phone).toBeNull();
      expect(contact.email).toBeNull();
    });
  });

  // fix/portal-balance-from-invoices — mapper puro de
  // `getPortalBalanceSummary` (groupBy(currency) + findFirst de Prisma ->
  // PortalBalanceSummary MULTI-MONEDA). Medido en prod: `Invoice.currency`
  // tiene `PES`/`DOL` (codigos de GR, no ISO), y clientes con impagas en
  // AMBAS monedas al mismo tiempo — este mapper es el que garantiza que
  // NUNCA se sumen entre si.
  describe('toPortalBalanceSummary', () => {
    it('una sola moneda con impagas: una entrada, suma balance (Decimal-like), ISO normalizado (PES -> ARS)', () => {
      const fakeDecimal = { toNumber: () => 75000 };
      const summary = toPortalBalanceSummary(
        [{ currency: 'PES', _sum: { balance: fakeDecimal }, _max: { createdAt: new Date('2026-07-01T00:00:00.000Z') } }],
        { currency: 'PES', createdAt: new Date('2026-07-20T00:00:00.000Z') },
      );
      expect(summary).toEqual({
        balances: [{ currency: 'ARS', amount: 75000 }],
        lastUpdatedAt: '2026-07-01T00:00:00.000Z',
      });
    });

    it('DOL -> USD', () => {
      const summary = toPortalBalanceSummary(
        [{ currency: 'DOL', _sum: { balance: 15 }, _max: { createdAt: new Date('2026-07-01T00:00:00.000Z') } }],
        { currency: 'DOL', createdAt: new Date('2026-07-01T00:00:00.000Z') },
      );
      expect(summary?.balances).toEqual([{ currency: 'USD', amount: 15 }]);
    });

    it('dos monedas con impagas: DOS entradas ordenadas por amount DESC, NINGUNA suma cruzada (el bug medido en prod)', () => {
      const summary = toPortalBalanceSummary(
        [
          { currency: 'PES', _sum: { balance: 20000 }, _max: { createdAt: new Date('2026-06-01T00:00:00.000Z') } },
          { currency: 'DOL', _sum: { balance: 50000 }, _max: { createdAt: new Date('2026-07-01T00:00:00.000Z') } },
        ],
        { currency: 'DOL', createdAt: new Date('2026-07-01T00:00:00.000Z') },
      );
      // El bug que este test reproduce: sumar ARS+USD en un solo numero daria
      // 70000 "sin moneda" — acá tienen que quedar DOS entradas separadas,
      // nunca colapsadas en un total unico.
      expect(summary?.balances).toEqual([
        { currency: 'USD', amount: 50000 },
        { currency: 'ARS', amount: 20000 },
      ]);
      expect(summary?.balances.length).toBe(2);
      // Anti-suma-cruzada: cada entrada preserva SU monto, ninguna moneda
      // "presta" ni "roba" del total de la otra.
      expect(summary?.balances.find((b) => b.currency === 'ARS')?.amount).toBe(20000);
      expect(summary?.balances.find((b) => b.currency === 'USD')?.amount).toBe(50000);
    });

    it('re-agrupa codigos crudos distintos que mapean al mismo ISO (PES y pes -> una sola entrada ARS)', () => {
      const summary = toPortalBalanceSummary(
        [
          { currency: 'PES', _sum: { balance: 10000 }, _max: { createdAt: new Date('2026-06-01T00:00:00.000Z') } },
          { currency: 'pes', _sum: { balance: 5000 }, _max: { createdAt: new Date('2026-07-01T00:00:00.000Z') } },
        ],
        { currency: 'pes', createdAt: new Date('2026-07-01T00:00:00.000Z') },
      );
      expect(summary?.balances).toEqual([{ currency: 'ARS', amount: 15000 }]);
    });

    it('sin impagas (todas pagadas): UNA entrada en 0 con la moneda de la factura mas reciente, fecha = anyInvoice.createdAt', () => {
      const summary = toPortalBalanceSummary(
        [],
        { currency: 'DOL', createdAt: new Date('2026-07-01T00:00:00.000Z') },
      );
      expect(summary).toEqual({
        balances: [{ currency: 'USD', amount: 0 }],
        lastUpdatedAt: '2026-07-01T00:00:00.000Z',
      });
    });

    it('sin NINGUNA factura (anyInvoice null): devuelve null, jamas balances vacio ni en 0', () => {
      const summary = toPortalBalanceSummary([], null);
      expect(summary).toBeNull();
    });

    it('currency null en la UNICA moneda impaga: asume ARS (no hay con que confundirse)', () => {
      const summary = toPortalBalanceSummary(
        [{ currency: null, _sum: { balance: 500 }, _max: { createdAt: new Date('2026-07-01T00:00:00.000Z') } }],
        { currency: null, createdAt: new Date('2026-07-01T00:00:00.000Z') },
      );
      expect(summary?.balances).toEqual([{ currency: 'ARS', amount: 500 }]);
    });

    it('currency null CONVIVIENDO con una moneda conocida: se etiqueta DESCONOCIDA, jamas se fusiona con la moneda real', () => {
      const summary = toPortalBalanceSummary(
        [
          { currency: 'PES', _sum: { balance: 1000 }, _max: { createdAt: new Date('2026-06-01T00:00:00.000Z') } },
          { currency: null, _sum: { balance: 300 }, _max: { createdAt: new Date('2026-07-01T00:00:00.000Z') } },
        ],
        { currency: 'PES', createdAt: new Date('2026-07-01T00:00:00.000Z') },
      );
      expect(summary?.balances).toEqual([
        { currency: 'ARS', amount: 1000 },
        { currency: 'DESCONOCIDA', amount: 300 },
      ]);
    });

    it('codigo desconocido (ni PES ni DOL) pasa TAL CUAL en mayusculas', () => {
      const summary = toPortalBalanceSummary(
        [{ currency: 'eur', _sum: { balance: 100 }, _max: { createdAt: new Date('2026-07-01T00:00:00.000Z') } }],
        { currency: 'eur', createdAt: new Date('2026-07-01T00:00:00.000Z') },
      );
      expect(summary?.balances).toEqual([{ currency: 'EUR', amount: 100 }]);
    });

    it('lastUpdatedAt es el max(createdAt) GLOBAL entre TODAS las monedas impagas, no por-moneda', () => {
      const summary = toPortalBalanceSummary(
        [
          { currency: 'PES', _sum: { balance: 1000 }, _max: { createdAt: new Date('2026-05-01T00:00:00.000Z') } },
          { currency: 'DOL', _sum: { balance: 200 }, _max: { createdAt: new Date('2026-07-15T00:00:00.000Z') } },
        ],
        { currency: 'DOL', createdAt: new Date('2026-07-15T00:00:00.000Z') },
      );
      expect(summary?.lastUpdatedAt).toBe('2026-07-15T00:00:00.000Z');
    });
  });
});
