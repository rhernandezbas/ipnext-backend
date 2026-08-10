import { GetClientDetail } from '../../application/use-cases/GetClientDetail';
import { RefreshClientBalanceIfStale } from '../../application/use-cases/RefreshClientBalanceIfStale';
import type { CustomerRepository } from '../../domain/ports/CustomerRepository';
import type { Customer } from '../../domain/entities/customer';
import { customerFrom, FIXED_NOW } from '../helpers/customerFixture';

const mockCustomer: Customer = {
  id: '42',
  name: 'Bob Martínez',
  email: 'bob@example.com',
  phone: '22-2222',
  status: 'inactive',
  address: 'Calle Falsa 123',
  city: 'Rosario',
  country: 'AR',
  login: 'bob',
  createdAt: '2024-02-01',
};

function makeRepo(overrides?: Partial<CustomerRepository>): CustomerRepository {
  return {
    list: jest.fn(),
    findById: jest.fn().mockResolvedValue(mockCustomer),
    create: jest.fn(),
    delete: jest.fn(),
    stats: jest.fn(),
    listContracts: jest.fn(),
    listInvoices: jest.fn(),
    listLogs: jest.fn(),
    updateLocation: jest.fn(),
    listActiveContacts: jest.fn().mockResolvedValue([]),
    getPortalBalanceSummary: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('GetClientDetail', () => {
  it('calls repo.findById with the given id', async () => {
    const repo = makeRepo();
    const uc = new GetClientDetail(repo);

    const result = await uc.execute('42');

    expect(repo.findById).toHaveBeenCalledWith('42');
    expect(result).toEqual(mockCustomer);
  });

  it('propagates errors from repo.findById', async () => {
    const repo = makeRepo({
      findById: jest.fn().mockRejectedValue(new Error('Not found')),
    });
    const uc = new GetClientDetail(repo);

    await expect(uc.execute('999')).rejects.toThrow('Not found');
  });

  describe('on-demand balance refresh gate', () => {
    function makeRefresh() {
      return { execute: jest.fn().mockResolvedValue(false) } as unknown as RefreshClientBalanceIfStale;
    }

    it('triggers the refresh for ANY client with a grClienteId (not just debtors)', async () => {
      // An ACTIVE client (status 'active') with a GR link must still sync.
      const activeWithGr: Customer = { ...mockCustomer, status: 'active', grClienteId: '100011', lastBalanceAt: null };
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(activeWithGr) });
      const refresh = makeRefresh();
      const uc = new GetClientDetail(repo, refresh);

      await uc.execute('42');

      // fix wave F7 — el `status` viaja al colaborador: es lo que le dice de qué
      // CARRIL sale el TTL. Sin él, la ficha de una baja mostraría "fresco"
      // (TTL 26h) mientras golpea GR cada 60min por detrás.
      expect(refresh.execute).toHaveBeenCalledWith({ grClienteId: '100011', lastBalanceAt: null, status: 'active' });
    });

    it('does NOT trigger the refresh for a client without a grClienteId', async () => {
      const noGr: Customer = { ...mockCustomer, status: 'active', grClienteId: null };
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(noGr) });
      const refresh = makeRefresh();
      const uc = new GetClientDetail(repo, refresh);

      await uc.execute('42');

      expect(refresh.execute).not.toHaveBeenCalled();
    });

    it('reloads the customer when the refresh fetched fresh data', async () => {
      const stale: Customer = { ...mockCustomer, status: 'active', grClienteId: '100011', balanceDue: null };
      const fresh: Customer = { ...stale, balanceDue: 5000 };
      const findById = jest.fn()
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(fresh);
      const repo = makeRepo({ findById });
      const refresh = { execute: jest.fn().mockResolvedValue(true) } as unknown as RefreshClientBalanceIfStale;
      const uc = new GetClientDetail(repo, refresh);

      const result = await uc.execute('42');

      expect(findById).toHaveBeenCalledTimes(2);
      expect(result.balanceDue).toBe(5000);
    });
  });

  // ─── customer-balance-unmask (Fase 3) — spec client-detail-balance ─────────
  // Fixtures via `customerFrom()` (design.md Decisión 7): el `Customer` nace del
  // mapper REAL, no de un literal con un par status/balanceDue que `toCustomer`
  // no podría producir.
  describe('balance contract (customer-balance-unmask)', () => {
    it('S23 — active client with real debt, fresh: GET /api/clients/:id (via execute()) responde balanceDue real, no el 0 hardcoded viejo', async () => {
      const freshCustomer = customerFrom({
        id: '42', status: 'active', grClienteId: '100011', balanceDue: 45000, balanceCurrency: 'ARS',
        // fix wave F11(c) — FIXED_NOW, no `new Date()`: el mapper del helper juzga
        // la frescura contra FIXED_NOW, así que un reloj real acá es una bomba de
        // tiempo (`fdd05af0`, "reloj fijo al gate del journey").
        lastBalanceAt: FIXED_NOW,
      });
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(freshCustomer) });
      const uc = new GetClientDetail(repo); // sin refresh collaborator — no debe hacer falta

      const result = await uc.execute('42');

      expect(result.balanceDue).toBe(45000);
      expect(result.balanceStale).toBe(false);
    });

    it('S25 — GR unreachable within the refresh timeout: fallback al balanceDue guardado + balanceStale:true, NUNCA throwea', async () => {
      const staleCustomer = customerFrom({
        id: '42', status: 'active', grClienteId: '100011', balanceDue: 8000, balanceCurrency: 'ARS',
        lastBalanceAt: new Date(FIXED_NOW.getTime() - 3 * 60 * 60 * 1000), // 3h — stale contra el TTL del carril rápido
      });
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(staleCustomer) });
      const refresh = { execute: jest.fn().mockResolvedValue(false) } as unknown as RefreshClientBalanceIfStale; // GR caído/timeout ⇒ RefreshClientBalanceIfStale.execute nunca throwea, resuelve false
      const uc = new GetClientDetail(repo, refresh);

      const result = await uc.execute('42');

      expect(result.balanceDue).toBe(8000);
      expect(result.balanceStale).toBe(true);
    });

    it('S26 — stale-but-known balance ships all three fields together (balanceDue + balanceStale:true + el lastBalanceAt viejo)', async () => {
      const oldTimestamp = new Date(FIXED_NOW.getTime() - 3 * 60 * 60 * 1000);
      const staleCustomer = customerFrom({
        id: '42', status: 'active', grClienteId: '100011', balanceDue: 12000, balanceCurrency: 'ARS',
        lastBalanceAt: oldTimestamp,
      }, { ttlMinutes: 60 });
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(staleCustomer) });
      const refresh = { execute: jest.fn().mockResolvedValue(false) } as unknown as RefreshClientBalanceIfStale;
      const uc = new GetClientDetail(repo, refresh);

      const result = await uc.execute('42');

      expect(result.balanceDue).toBe(12000);
      expect(result.balanceStale).toBe(true);
      expect(result.lastBalanceAt).toBe(oldTimestamp.toISOString());
    });

    it('S27 — no GR link: sin refresh, balanceDue:null (regresión, ya lo hacía bien pero ahora vía toCustomer real)', async () => {
      const unlinkedCustomer = customerFrom({ id: '42', status: 'active', grClienteId: null });
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(unlinkedCustomer) });
      const refresh = { execute: jest.fn() } as unknown as RefreshClientBalanceIfStale;
      const uc = new GetClientDetail(repo, refresh);

      const result = await uc.execute('42');

      expect(refresh.execute).not.toHaveBeenCalled();
      expect(result.balanceDue).toBeNull();
    });
  });
});
