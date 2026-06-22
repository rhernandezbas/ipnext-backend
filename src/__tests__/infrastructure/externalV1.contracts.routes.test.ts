import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { createExternalV1Router } from '@infrastructure/http/routes/externalV1.routes';
import { createApiKeyMiddleware } from '@infrastructure/http/middleware/apiKeyMiddleware';
import { ListClients } from '@application/use-cases/ListClients';
import { GetClientDetail } from '@application/use-cases/GetClientDetail';
import { ListContracts } from '@application/use-cases/ListContracts';
import { PaginatedContractsDto, ContractSummaryDto } from '@application/dto/contract.dto';

// Control the API key without real env vars
jest.mock('../../infrastructure/config', () => ({
  config: {
    externalApi: { apiKey: 'test-external-key' },
  },
}));

const TEST_KEY = 'test-external-key';

/** A ContractSummaryDto with null technology — should be derived from plan. */
const FULL_CONTRACT_SUMMARY: ContractSummaryDto = {
  id: 'contract-uuid-001',
  code: 'GR-001',
  clientId: 'client-uuid-001',
  clientName: 'Juan Pérez',
  plan: '300MB',
  status: 'active',
  technology: null,          // null — should be derived from plan → 'Fiber'
  startDate: '2024-01-15T10:00:00.000Z',
};

/** Manual technology (FTTH) — must NOT be overridden even though plan speed is < 100. */
const MANUAL_TECH_CONTRACT: ContractSummaryDto = {
  id: 'contract-uuid-002',
  code: 'GR-002',
  clientId: 'client-uuid-002',
  clientName: 'María García',
  plan: '50/25MB',
  status: 'active',
  technology: 'FTTH',        // manual value — must NOT be overridden by derived
  startDate: '2024-02-20T08:00:00.000Z',
};

/** Low-speed plan + null technology → should derive 'Wireless'. */
const LOW_SPEED_CONTRACT: ContractSummaryDto = {
  id: 'contract-uuid-003',
  code: null,
  clientId: 'client-uuid-003',
  clientName: 'Pedro Rojas',
  plan: '20/5MB GRAL',
  status: 'inactive',
  technology: null,          // null — should derive to 'Wireless'
  startDate: '2024-03-01T00:00:00.000Z',
};

// ─── Stub factories ────────────────────────────────────────────────────────

function makeListClients(): ListClients {
  return {
    execute: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 25 }),
  } as unknown as ListClients;
}

function makeGetClientDetail(): GetClientDetail {
  return {
    execute: jest.fn(),
  } as unknown as GetClientDetail;
}

function makeListContracts(contracts: ContractSummaryDto[], totalOverride?: number): ListContracts {
  const result: PaginatedContractsDto = {
    data: contracts,
    total: totalOverride ?? contracts.length,
    page: 1,
    pageSize: contracts.length || 25,
    totalPages: 1,
  };
  return {
    execute: jest.fn().mockResolvedValue(result),
  } as unknown as ListContracts;
}

function buildApp(listContracts: ListContracts) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/external/v1',
    createApiKeyMiddleware(),
    createExternalV1Router(makeListClients(), makeGetClientDetail(), listContracts),
  );
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

// ─── Auth guard ───────────────────────────────────────────────────────────

describe('GET /api/external/v1/contracts — auth', () => {
  it('returns 401 when no API key is provided', async () => {
    const app = buildApp(makeListContracts([FULL_CONTRACT_SUMMARY]));
    const res = await request(app).get('/api/external/v1/contracts');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when wrong API key is provided', async () => {
    const app = buildApp(makeListContracts([FULL_CONTRACT_SUMMARY]));
    const res = await request(app)
      .get('/api/external/v1/contracts')
      .set('X-API-Key', 'wrong-key');

    expect(res.status).toBe(401);
  });

  it('returns 200 with valid API key', async () => {
    const app = buildApp(makeListContracts([FULL_CONTRACT_SUMMARY]));
    const res = await request(app)
      .get('/api/external/v1/contracts')
      .set('X-API-Key', TEST_KEY);

    expect(res.status).toBe(200);
  });
});

// ─── Technology derivation ────────────────────────────────────────────────

describe('GET /api/external/v1/contracts — technology derivation', () => {
  it('derives technology from plan when stored technology is null (300MB → Fiber)', async () => {
    const app = buildApp(makeListContracts([FULL_CONTRACT_SUMMARY]));
    const res = await request(app)
      .get('/api/external/v1/contracts')
      .set('X-API-Key', TEST_KEY);

    expect(res.status).toBe(200);
    const contract = res.body.data[0];
    expect(contract.technology).toBe('Fiber');
  });

  it('preserves manual technology (FTTH) even when plan speed < 100 would suggest Wireless', async () => {
    const app = buildApp(makeListContracts([MANUAL_TECH_CONTRACT]));
    const res = await request(app)
      .get('/api/external/v1/contracts')
      .set('X-API-Key', TEST_KEY);

    expect(res.status).toBe(200);
    const contract = res.body.data[0];
    // FTTH is the manual value; plan 50/25MB would derive Wireless — manual MUST win
    expect(contract.technology).toBe('FTTH');
  });

  it('derives "Wireless" for null technology + plan "20/5MB GRAL"', async () => {
    const app = buildApp(makeListContracts([LOW_SPEED_CONTRACT]));
    const res = await request(app)
      .get('/api/external/v1/contracts')
      .set('X-API-Key', TEST_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data[0].technology).toBe('Wireless');
  });
});

// ─── DTO hygiene ─────────────────────────────────────────────────────────

describe('GET /api/external/v1/contracts — DTO hygiene', () => {
  it('response does NOT contain sensitive fields (ip, vendedor, name, services, type, endDate)', async () => {
    const app = buildApp(makeListContracts([FULL_CONTRACT_SUMMARY]));
    const res = await request(app)
      .get('/api/external/v1/contracts')
      .set('X-API-Key', TEST_KEY);

    expect(res.status).toBe(200);
    const contract = res.body.data[0];

    expect(contract).not.toHaveProperty('ip');
    expect(contract).not.toHaveProperty('vendedor');
    expect(contract).not.toHaveProperty('name');
    expect(contract).not.toHaveProperty('services');
    expect(contract).not.toHaveProperty('type');
    expect(contract).not.toHaveProperty('endDate');
    expect(contract).not.toHaveProperty('clientName');  // internal join field
  });

  it('response DOES contain required curated fields (id, code, clientId, plan, status, technology, startDate)', async () => {
    const app = buildApp(makeListContracts([FULL_CONTRACT_SUMMARY]));
    const res = await request(app)
      .get('/api/external/v1/contracts')
      .set('X-API-Key', TEST_KEY);

    expect(res.status).toBe(200);
    const contract = res.body.data[0];

    expect(contract).toHaveProperty('id', FULL_CONTRACT_SUMMARY.id);
    expect(contract).toHaveProperty('code', FULL_CONTRACT_SUMMARY.code);
    expect(contract).toHaveProperty('clientId', FULL_CONTRACT_SUMMARY.clientId);
    expect(contract).toHaveProperty('plan', FULL_CONTRACT_SUMMARY.plan);
    expect(contract).toHaveProperty('status', FULL_CONTRACT_SUMMARY.status);
    expect(contract).toHaveProperty('technology');
    expect(contract).toHaveProperty('startDate', FULL_CONTRACT_SUMMARY.startDate);
  });
});

// ─── Pagination ───────────────────────────────────────────────────────────

describe('GET /api/external/v1/contracts — pagination', () => {
  it('returns paginated envelope with data, total, page, limit, totalPages', async () => {
    const listContracts = makeListContracts([FULL_CONTRACT_SUMMARY], 50);
    (listContracts.execute as jest.Mock).mockResolvedValue({
      data: [FULL_CONTRACT_SUMMARY],
      total: 50,
      page: 2,
      pageSize: 10,
      totalPages: 5,
    });
    const app = buildApp(listContracts);
    const res = await request(app)
      .get('/api/external/v1/contracts?page=2&limit=10')
      .set('X-API-Key', TEST_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total', 50);
    expect(res.body).toHaveProperty('page', 2);
    expect(res.body).toHaveProperty('limit', 10);
    expect(res.body).toHaveProperty('totalPages', 5);
  });

  it('clamps limit to max 100', async () => {
    const listContracts = makeListContracts([]);
    const app = buildApp(listContracts);
    await request(app)
      .get('/api/external/v1/contracts?limit=9999')
      .set('X-API-Key', TEST_KEY);

    const executeSpy = listContracts.execute as jest.Mock;
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('passes search, status, technology query params to use case', async () => {
    const listContracts = makeListContracts([]);
    const app = buildApp(listContracts);
    await request(app)
      .get('/api/external/v1/contracts?search=test&status=active&technology=Fiber')
      .set('X-API-Key', TEST_KEY);

    const executeSpy = listContracts.execute as jest.Mock;
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'test', status: 'active', technology: 'Fiber' }),
    );
  });

  it('defaults to page=1, limit=25 when not specified', async () => {
    const listContracts = makeListContracts([]);
    const app = buildApp(listContracts);
    await request(app)
      .get('/api/external/v1/contracts')
      .set('X-API-Key', TEST_KEY);

    const executeSpy = listContracts.execute as jest.Mock;
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 25 }),
    );
  });
});
