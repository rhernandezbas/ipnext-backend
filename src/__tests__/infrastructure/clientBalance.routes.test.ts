/**
 * Integration test: GET /api/clients/:id with balance fields.
 * Uses in-memory repos injected via a minimal test app.
 */
import request from 'supertest';
import express from 'express';
import { createClientsRouter } from '@infrastructure/http/routes/clients.routes';
import { ListClients } from '@application/use-cases/ListClients';
import { GetClientDetail } from '@application/use-cases/GetClientDetail';
import { GetClientContracts } from '@application/use-cases/GetClientContracts';
import { GetClientInvoices } from '@application/use-cases/GetClientInvoices';
import { GetClientLogs } from '@application/use-cases/GetClientLogs';
import { CreateCustomer } from '@application/use-cases/CreateCustomer';
import { GetClientStats } from '@application/use-cases/GetClientStats';
import { DeleteCustomer } from '@application/use-cases/DeleteCustomer';
import { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { Customer } from '@domain/entities/customer';
import { CustomerRepository } from '@domain/ports/CustomerRepository';
import { JwtAuthAdapter } from '@infrastructure/adapters/jwt/JwtAuthAdapter';
import cookieParser from 'cookie-parser';

// Minimal stub auth that always passes
const authStub = {
  getSession: jest.fn().mockResolvedValue({ id: 'admin-1', email: 'test@test.com', role: 'admin', username: 'admin' }),
} as unknown as JwtAuthAdapter;

// Debtor customer with stale balance
const DEBTOR: Customer = {
  id: 'debtor-1',
  grClienteId: '100011',
  name: 'Deudor Test',
  email: 'd@test.com',
  phone: '123',
  status: 'late',
  address: 'Calle 1',
  city: 'Mercedes',
  country: 'AR',
  login: 'debtor1',
  createdAt: '2026-01-01T00:00:00.000Z',
  balanceDue: null,
  balanceCurrency: null,
  lastBalanceAt: null,
  balanceStale: true,
};

const DEBTOR_FRESH: Customer = {
  ...DEBTOR,
  balanceDue: 65722.07,
  balanceCurrency: 'ARS',
  lastBalanceAt: new Date().toISOString(),
  balanceStale: false,
};

function makeCustomerRepo(debtor: Customer, fresh?: Customer): CustomerRepository {
  let callCount = 0;
  return {
    findById: jest.fn().mockImplementation(() => {
      callCount++;
      // First call returns stale, second call (after refresh) returns fresh
      return Promise.resolve(callCount > 1 && fresh ? fresh : debtor);
    }),
    list: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 25 }),
    create: jest.fn(),
    delete: jest.fn(),
    stats: jest.fn().mockResolvedValue({ total: 1, active: 0, inactive: 0, blocked: 0, late: 1 }),
    listContracts: jest.fn().mockResolvedValue([]),
    listInvoices: jest.fn().mockResolvedValue([]),
    listLogs: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 25 }),
    updateLocation: jest.fn(),
  };
}

function buildApp(customerRepo: CustomerRepository, gr?: InMemoryGestionRealPort, mirror?: InMemoryClientMirrorRepository) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  let balanceRefresh: RefreshClientBalanceIfStale | undefined;
  if (gr && mirror) {
    balanceRefresh = new RefreshClientBalanceIfStale(gr, mirror, { ttlMinutes: 60 });
  }

  const getDetail = new GetClientDetail(customerRepo, balanceRefresh);
  const listClients = new ListClients(customerRepo);
  const getContracts = new GetClientContracts(customerRepo);
  const getInvoices = new GetClientInvoices(customerRepo);
  const getLogs = new GetClientLogs(customerRepo);
  const createCustomer = new CreateCustomer(customerRepo);
  const getStats = new GetClientStats(customerRepo);
  const deleteCustomer = new DeleteCustomer(customerRepo);

  app.use('/api/clients', createClientsRouter(
    listClients, getDetail, getContracts, getInvoices, getLogs,
    authStub, createCustomer, getStats, deleteCustomer,
  ));

  // Simple error handler
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'internal' });
  });

  return app;
}

describe('GET /api/clients/:id — balance fields', () => {
  it('returns balance fields for a debtor when GR succeeds', async () => {
    const gr = new InMemoryGestionRealPort();
    const mirror = new InMemoryClientMirrorRepository();
    gr.balancesByClient['100011'] = { grClienteId: '100011', amount: 65722.07, currency: 'ARS', invoicesQty: 2, paymentUrls: {}, invoices: [], raw: {} };

    const repo = makeCustomerRepo(DEBTOR, DEBTOR_FRESH);
    const app = buildApp(repo, gr, mirror);

    const res = await request(app)
      .get('/api/clients/debtor-1')
      .set('Cookie', 'auth_token=fake-token');

    expect(res.status).toBe(200);
    // After refresh, should return fresh data
    expect(res.body.balanceDue).toBe(65722.07);
    expect(res.body.balanceStale).toBe(false);
  });

  it('returns 200 with balanceStale=true when GR is down (never 500)', async () => {
    const gr = new InMemoryGestionRealPort();
    gr.balanceError = new Error('GR connection refused');
    const mirror = new InMemoryClientMirrorRepository();

    const repo = makeCustomerRepo(DEBTOR);
    const app = buildApp(repo, gr, mirror);

    const res = await request(app)
      .get('/api/clients/debtor-1')
      .set('Cookie', 'auth_token=fake-token');

    expect(res.status).toBe(200);
    expect(res.body.balanceStale).toBe(true);
  });

  it('returns 200 with balance fields even without GR configured', async () => {
    const repo = makeCustomerRepo(DEBTOR);
    // No gr/mirror — no on-demand refresh
    const app = buildApp(repo);

    const res = await request(app)
      .get('/api/clients/debtor-1')
      .set('Cookie', 'auth_token=fake-token');

    expect(res.status).toBe(200);
    expect(res.body.balanceStale).toBe(true);
  });
});
