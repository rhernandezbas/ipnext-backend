/**
 * #47 — type witnesses for the Gigared ports. Shapes are camelCase VERBATIM from design.md.
 * These tests exist to pin the contract: if a field is renamed/removed, the witness stops compiling.
 */
import type {
  GigaredPort,
  GigaredAccount,
  GigaredSummary,
  GigaredService,
  GigaredOtt,
  GigaredPartnerService,
  ListAccountsFilter,
} from '@domain/ports/GigaredPort';
import type {
  GigaredConfig,
  GigaredConfigRepository,
} from '@domain/ports/GigaredConfigRepository';

describe('Gigared ports shape witnesses (#47)', () => {
  it('GigaredAccount carries camelCase fields incl. ott + services', () => {
    const svc: GigaredService = { id: '129', name: 'Gigared Play Full' };
    const ott: GigaredOtt = {
      id: 'GIGA10000000100',
      stationaryLicenses: 3,
      mobileLicenses: 5,
      registeredDevices: 0,
      status: 'disabled',
    };
    const acc: GigaredAccount = {
      cic: '0000000001',
      gigaredId: '10000000100',
      email: 'x@y.com',
      firstName: 'Nombre',
      lastName: 'Apellido',
      registrationDate: '2026-01-19',
      services: [svc],
      internalId: 'CLIENTE_001',
      clientId: 'CLIENTE_001',
      ott,
    };
    expect(acc.services[0]!.name).toBe('Gigared Play Full');
    expect(acc.ott!.stationaryLicenses).toBe(3);
  });

  it('GigaredSummary carries account counts + partner services with quantities', () => {
    const ps: GigaredPartnerService = {
      id: '129',
      name: 'Gigared Play Full',
      qtyAvailable: 0,
      qtyUsed: 1000,
      qtyPurchased: 1000,
    };
    const summary: GigaredSummary = {
      accounts: { registered: 3, unregistered: 997, total: 1000 },
      services: [ps],
    };
    expect(summary.accounts.total).toBe(1000);
    expect(summary.services[0]!.qtyPurchased).toBe(1000);
  });

  it('ListAccountsFilter is fully optional + camelCase', () => {
    const f: ListAccountsFilter = { email: 'a@b.com', status: 'registered', paginationLimit: 20, paginationOffset: 0 };
    expect(f.status).toBe('registered');
  });

  it('GigaredPort method set is the frozen port contract', () => {
    const fake: GigaredPort = {
      getSummary: async () => ({ accounts: { registered: 0, unregistered: 0, total: 0 }, services: [] }),
      listAccounts: async () => [],
      getAccountByInternalId: async () => { throw new Error('x'); },
      getAccountByCic: async () => { throw new Error('x'); },
      register: async () => {},
      activate: async () => {},
      setInternalId: async () => {},
      addService: async () => {},
      removeService: async () => {},
      setOtt: async () => {},
      changePassword: async () => {},
      renewCic: async () => ({ oldCic: '0000000001', newCic: '0000000002' }),
    };
    expect(typeof fake.getSummary).toBe('function');
    expect(typeof fake.setOtt).toBe('function');
    expect(typeof fake.renewCic).toBe('function');
  });

  it('GigaredConfigRepository get/update shape', () => {
    const cfg: GigaredConfig = { apiKey: 'k', baseUrl: 'https://x', updatedAt: '2026-06-30T00:00:00.000Z' };
    const repo: GigaredConfigRepository = {
      get: async () => cfg,
      update: async () => cfg,
    };
    expect(typeof repo.get).toBe('function');
    expect(cfg.baseUrl).toBe('https://x');
  });
});
