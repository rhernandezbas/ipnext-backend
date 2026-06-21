import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { createExternalV1Router } from '../../infrastructure/http/routes/externalV1.routes';
import { createApiKeyMiddleware } from '../../infrastructure/http/middleware/apiKeyMiddleware';
import { config } from '../../infrastructure/config';
import { ClientNotFoundError } from '../../domain/errors';
import { Customer } from '../../domain/entities/customer';
import { ListClients } from '../../application/use-cases/ListClients';
import { GetClientDetail } from '../../application/use-cases/GetClientDetail';

// Mock config so we control the API key without env vars
jest.mock('../../infrastructure/config', () => ({
  config: {
    externalApi: { apiKey: 'test-external-key' },
  },
}));

const TEST_KEY = 'test-external-key';

/**
 * A Customer with ALL sensitive fields populated — used to assert the DTO
 * excludes them while preserving the safe fields.
 */
const FULL_CUSTOMER: Customer = {
  id: 'uuid-001',
  grClienteId: 'gr-99',              // MUST be excluded
  name: 'Juan Pérez',
  email: 'juan@example.com',
  phone: '+5491100000000',
  status: 'active',
  address: 'Av. Siempre Viva 742',
  city: 'Buenos Aires',
  country: 'AR',
  login: 'juan.perez',               // MUST be excluded
  createdAt: '2024-01-15T10:00:00.000Z',
  customAttributes: { internalNote: 'secret' },  // MUST be excluded
  balanceDue: 15000,                 // MUST be excluded
  balanceCurrency: 'ARS',            // MUST be excluded
  lastBalanceAt: '2024-06-01T00:00:00.000Z',     // MUST be excluded
  balanceStale: false,               // MUST be excluded
};

const SECOND_CUSTOMER: Customer = {
  id: 'uuid-002',
  name: 'María García',
  email: 'maria@example.com',
  phone: '+5491100000001',
  status: 'late',
  address: 'Calle Falsa 123',
  city: 'Córdoba',
  country: 'AR',
  login: 'maria.garcia',
  createdAt: '2024-02-20T08:00:00.000Z',
};

// Create stub use cases — no real CustomerRepository needed
function makeListClients(customers: Customer[]): ListClients {
  const stub = {
    execute: jest.fn().mockResolvedValue({
      data: customers,
      total: customers.length,
      page: 1,
      limit: 25,
    }),
  } as unknown as ListClients;
  return stub;
}

function makeGetClientDetail(customer: Customer | null): GetClientDetail {
  const stub = {
    execute: jest.fn().mockImplementation(async (id: string) => {
      if (customer === null || customer.id !== id) {
        throw new ClientNotFoundError(id);
      }
      return customer;
    }),
  } as unknown as GetClientDetail;
  return stub;
}

function buildApp(
  listClients: ListClients,
  getClientDetail: GetClientDetail,
) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/external/v1',
    createApiKeyMiddleware(),
    createExternalV1Router(listClients, getClientDetail),
  );
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

// ─── GET /api/external/v1/clients ────────────────────────────────────────────

describe('GET /api/external/v1/clients', () => {
  it('returns 401 when no API key is provided', async () => {
    const app = buildApp(makeListClients([FULL_CUSTOMER]), makeGetClientDetail(FULL_CUSTOMER));
    const res = await request(app).get('/api/external/v1/clients');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when wrong API key is provided', async () => {
    const app = buildApp(makeListClients([FULL_CUSTOMER]), makeGetClientDetail(FULL_CUSTOMER));
    const res = await request(app)
      .get('/api/external/v1/clients')
      .set('X-API-Key', 'wrong-key');

    expect(res.status).toBe(401);
  });

  it('returns 200 with paginated DTO list when valid key (X-API-Key)', async () => {
    const app = buildApp(
      makeListClients([FULL_CUSTOMER, SECOND_CUSTOMER]),
      makeGetClientDetail(FULL_CUSTOMER),
    );
    const res = await request(app)
      .get('/api/external/v1/clients')
      .set('X-API-Key', TEST_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(25);
    expect(typeof res.body.totalPages).toBe('number');
  });

  it('returns 200 with valid key via Authorization Bearer', async () => {
    const app = buildApp(makeListClients([FULL_CUSTOMER]), makeGetClientDetail(FULL_CUSTOMER));
    const res = await request(app)
      .get('/api/external/v1/clients')
      .set('Authorization', `Bearer ${TEST_KEY}`);

    expect(res.status).toBe(200);
  });

  it('DTO hygiene — response DOES NOT include sensitive fields', async () => {
    const app = buildApp(makeListClients([FULL_CUSTOMER]), makeGetClientDetail(FULL_CUSTOMER));
    const res = await request(app)
      .get('/api/external/v1/clients')
      .set('X-API-Key', TEST_KEY);

    expect(res.status).toBe(200);
    const client = res.body.data[0];

    // Sensitive fields MUST be absent
    expect(client).not.toHaveProperty('login');
    expect(client).not.toHaveProperty('grClienteId');
    expect(client).not.toHaveProperty('balanceDue');
    expect(client).not.toHaveProperty('balanceCurrency');
    expect(client).not.toHaveProperty('lastBalanceAt');
    expect(client).not.toHaveProperty('balanceStale');
    expect(client).not.toHaveProperty('customAttributes');

    // Safe fields MUST be present
    expect(client).toHaveProperty('id', FULL_CUSTOMER.id);
    expect(client).toHaveProperty('name', FULL_CUSTOMER.name);
    expect(client).toHaveProperty('email', FULL_CUSTOMER.email);
    expect(client).toHaveProperty('phone', FULL_CUSTOMER.phone);
    expect(client).toHaveProperty('status', FULL_CUSTOMER.status);
    expect(client).toHaveProperty('address', FULL_CUSTOMER.address);
    expect(client).toHaveProperty('city', FULL_CUSTOMER.city);
    expect(client).toHaveProperty('country', FULL_CUSTOMER.country);
    expect(client).toHaveProperty('createdAt', FULL_CUSTOMER.createdAt);
  });

  it('passes pagination params to use case', async () => {
    const listClients = makeListClients([FULL_CUSTOMER]);
    const app = buildApp(listClients, makeGetClientDetail(FULL_CUSTOMER));
    await request(app)
      .get('/api/external/v1/clients?page=2&limit=10')
      .set('X-API-Key', TEST_KEY);

    const executeSpy = listClients.execute as jest.Mock;
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 10 }),
    );
  });

  it('clamps limit to max 100', async () => {
    const listClients = makeListClients([]);
    const app = buildApp(listClients, makeGetClientDetail(null));
    await request(app)
      .get('/api/external/v1/clients?limit=9999')
      .set('X-API-Key', TEST_KEY);

    const executeSpy = listClients.execute as jest.Mock;
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });
});

// ─── GET /api/external/v1/clients/:id ────────────────────────────────────────

describe('GET /api/external/v1/clients/:id', () => {
  it('returns 200 single DTO for valid id', async () => {
    const app = buildApp(makeListClients([]), makeGetClientDetail(FULL_CUSTOMER));
    const res = await request(app)
      .get(`/api/external/v1/clients/${FULL_CUSTOMER.id}`)
      .set('X-API-Key', TEST_KEY);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(FULL_CUSTOMER.id);
    expect(res.body.name).toBe(FULL_CUSTOMER.name);
  });

  it('returns 404 for unknown id', async () => {
    const app = buildApp(makeListClients([]), makeGetClientDetail(null));
    const res = await request(app)
      .get('/api/external/v1/clients/nonexistent-id')
      .set('X-API-Key', TEST_KEY);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CLIENT_NOT_FOUND');
  });

  it('returns 401 without API key', async () => {
    const app = buildApp(makeListClients([]), makeGetClientDetail(FULL_CUSTOMER));
    const res = await request(app).get(`/api/external/v1/clients/${FULL_CUSTOMER.id}`);

    expect(res.status).toBe(401);
  });

  it('DTO hygiene on single client — no sensitive fields', async () => {
    const app = buildApp(makeListClients([]), makeGetClientDetail(FULL_CUSTOMER));
    const res = await request(app)
      .get(`/api/external/v1/clients/${FULL_CUSTOMER.id}`)
      .set('X-API-Key', TEST_KEY);

    expect(res.status).toBe(200);
    const body = res.body;

    // Sensitive fields MUST be absent
    expect(body).not.toHaveProperty('login');
    expect(body).not.toHaveProperty('grClienteId');
    expect(body).not.toHaveProperty('balanceDue');
    expect(body).not.toHaveProperty('balanceCurrency');
    expect(body).not.toHaveProperty('lastBalanceAt');
    expect(body).not.toHaveProperty('balanceStale');
    expect(body).not.toHaveProperty('customAttributes');

    // Safe fields MUST be present
    expect(body).toHaveProperty('address', FULL_CUSTOMER.address);
    expect(body).toHaveProperty('city', FULL_CUSTOMER.city);
    expect(body).toHaveProperty('country', FULL_CUSTOMER.country);
  });
});
