import request from 'supertest';
import express from 'express';
import { InMemoryIClassNodeRepository } from '../../../infrastructure/adapters/in-memory/InMemoryIClassNodeRepository';
import { InMemoryIClassTeamRepository } from '../../../infrastructure/adapters/in-memory/InMemoryIClassTeamRepository';
import { InMemoryProjectRepository } from '../../../infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { InMemoryNetworkSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { ListIClassNodeCatalog } from '../../../application/use-cases/ListIClassNodeCatalog';
import { ListIClassTeams } from '../../../application/use-cases/ListIClassTeams';
import { ListClients } from '../../../application/use-cases/ListClients';
import { GetClientContracts } from '../../../application/use-cases/GetClientContracts';
import { ListProjects } from '../../../application/use-cases/ListProjects';
import { ListNetworkSites } from '../../../application/use-cases/ListNetworkSites';
import { createInternalCatalogsRouter } from '../../../infrastructure/http/routes/internal-catalogs.routes';
import { errorHandler } from '../../../infrastructure/http/middleware/errorHandler';
import type { CustomerRepository, ListClientsQuery } from '../../../domain/ports/CustomerRepository';
import type { Customer, Contract } from '../../../domain/entities/customer';
import type { PaginatedResult } from '../../../domain/entities/pagination';

/**
 * No `InMemoryCustomerRepository` adapter exists yet anywhere in the repo (grepped
 * `implements CustomerRepository` — only `SplynxCustomerAdapter`, the legacy live
 * adapter, and the Prisma one). Building a full 11-method in-memory adapter just
 * for these 2 read-only endpoints would be scope creep — same fixture-only
 * convention as `src/__tests__/helpers/customerFixture.ts` / `ListClients.test.ts`
 * (`makeRepo` with `jest.fn()` for anything unused). Only `list`/`listContracts`
 * carry real filtering logic here because the new routes actually exercise it
 * (search filtering, no-contracts case); everything else is a stub.
 */
function makeCustomerRepo(
  customers: Customer[],
  contractsByClientId: Record<string, Contract[]> = {},
): CustomerRepository {
  return {
    list: async (query: ListClientsQuery): Promise<PaginatedResult<Customer>> => {
      const page = query.page ?? 1;
      const limit = query.limit ?? 25;
      let items = customers;
      if (query.search) {
        const s = query.search.toLowerCase();
        items = items.filter(
          c =>
            c.name.toLowerCase().includes(s) ||
            c.email.toLowerCase().includes(s) ||
            c.login.toLowerCase().includes(s) ||
            c.phone.toLowerCase().includes(s),
        );
      }
      const total = items.length;
      const start = (page - 1) * limit;
      return { data: items.slice(start, start + limit), total, page, limit };
    },
    findById: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    stats: jest.fn(),
    listContracts: async (clientId: string): Promise<Contract[]> => contractsByClientId[clientId] ?? [],
    listInvoices: jest.fn(),
    getPortalBalanceSummary: jest.fn().mockResolvedValue(null),
    listLogs: jest.fn(),
    updateLocation: jest.fn(),
    listActiveContacts: jest.fn().mockResolvedValue([]),
  };
}

function buildApp(
  customers: Customer[] = [],
  contractsByClientId: Record<string, Contract[]> = {},
) {
  const app = express();
  app.use(express.json());

  const nodeRepo = new InMemoryIClassNodeRepository();
  const teamRepo = new InMemoryIClassTeamRepository();
  const projectRepo = new InMemoryProjectRepository();
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  const customerRepo = makeCustomerRepo(customers, contractsByClientId);

  const listIClassNodeCatalog = new ListIClassNodeCatalog(nodeRepo);
  const listIClassTeams = new ListIClassTeams(teamRepo);
  const listClients = new ListClients(customerRepo);
  const getContracts = new GetClientContracts(customerRepo);
  const listProjectsUC = new ListProjects(projectRepo);
  const listNetworkSites = new ListNetworkSites(networkSiteRepo);

  // No auth middleware whatsoever — internal-only, same criterion as internal-tasks.routes.ts.
  app.use('/api/internal/catalogs', createInternalCatalogsRouter({
    listIClassNodeCatalog,
    listIClassTeams,
    listClients,
    getContracts,
    listProjectsUC,
    listNetworkSites,
  }));

  app.use(errorHandler);

  return { app, nodeRepo, teamRepo, projectRepo, networkSiteRepo };
}

const CUSTOMER_BASE: Customer = {
  id: 'c-1',
  name: 'Ronald Hernandez',
  email: 'ronald@example.com',
  phone: '11-2222-3333',
  status: 'active',
  address: 'Calle Falsa 123',
  city: 'Mercedes',
  country: 'AR',
  login: 'ronaldh',
  createdAt: '2024-01-01T00:00:00.000Z',
};

const CONTRACT_BASE: Contract = {
  id: 'ct-1',
  code: 'GR-100',
  type: 'internet',
  plan: '100MB',
  ip: '10.0.0.1',
  status: 'active',
  startDate: '2024-01-01T00:00:00.000Z',
  endDate: '',
  address: 'Calle Falsa 123',
  lat: null,
  lng: null,
  technology: 'Fiber',
  name: null,
  vendedor: null,
  services: [],
};

describe('GET /api/internal/catalogs/cities — no auth required', () => {
  it('returns the IClass node catalog without any auth header/cookie', async () => {
    const { app, nodeRepo } = buildApp();
    await nodeRepo.upsertByNodeId({ nodeId: 1, code: 'Rosario', description: 'Rosario', selectable: true });
    await nodeRepo.upsertByNodeId({ nodeId: 2, code: 'Main', description: 'Main', selectable: false });

    const res = await request(app).get('/api/internal/catalogs/cities');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const codes = res.body.items.map((i: { code: string }) => i.code).sort();
    expect(codes).toEqual(['Main', 'Rosario']);
  });

  it('?active=true filters to only active nodes', async () => {
    const { app, nodeRepo } = buildApp();
    await nodeRepo.upsertByNodeId({ nodeId: 1, code: 'Rosario', description: 'Rosario', selectable: true });
    await nodeRepo.markInactiveExcept([]); // deactivates Rosario
    await nodeRepo.upsertByNodeId({ nodeId: 2, code: 'Chivilcoy', description: 'Chivilcoy', selectable: true });

    const res = await request(app).get('/api/internal/catalogs/cities').query({ active: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].code).toBe('Chivilcoy');
  });
});

describe('GET /api/internal/catalogs/teams — no auth required', () => {
  it('returns the IClass team catalog without any auth header/cookie', async () => {
    const { app, teamRepo } = buildApp();
    await teamRepo.upsertByLogin({ login: 'equipe-1', name: 'Equipe Uno', thirdPartyCode: null, active: true, selectable: true });
    await teamRepo.upsertByLogin({ login: 'equipe-2', name: 'Equipe Dos', thirdPartyCode: 'TP-2', active: false, selectable: true });

    const res = await request(app).get('/api/internal/catalogs/teams');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const logins = res.body.items.map((i: { login: string }) => i.login).sort();
    expect(logins).toEqual(['equipe-1', 'equipe-2']);
    const first = res.body.items.find((i: { login: string }) => i.login === 'equipe-1');
    expect(first).toMatchObject({ login: 'equipe-1', name: 'Equipe Uno', active: true, selectable: true });
  });
});

describe('GET /api/internal/catalogs/clients — no auth required', () => {
  it('returns the client catalog without any auth header/cookie', async () => {
    const { app } = buildApp([CUSTOMER_BASE]);

    const res = await request(app).get('/api/internal/catalogs/clients');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, page: 1, limit: 25 });
    expect(res.body.items).toEqual([
      {
        id: 'c-1',
        name: 'Ronald Hernandez',
        email: 'ronald@example.com',
        phone: '11-2222-3333',
        status: 'active',
        address: 'Calle Falsa 123',
        city: 'Mercedes',
        country: 'AR',
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    // Curated allow-list — internal fields never leak.
    expect(res.body.items[0]).not.toHaveProperty('login');
    expect(res.body.items[0]).not.toHaveProperty('balanceDue');
  });

  it('?search= filters clients by name/email/login/phone (case-insensitive)', async () => {
    const other: Customer = { ...CUSTOMER_BASE, id: 'c-2', name: 'Maria Lopez', email: 'maria@example.com', login: 'marial', phone: '11-9999-0000' };
    const { app } = buildApp([CUSTOMER_BASE, other]);

    const res = await request(app).get('/api/internal/catalogs/clients').query({ search: 'hernandez' });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('c-1');
  });

  it('supports ?page=&limit= pagination', async () => {
    const other: Customer = { ...CUSTOMER_BASE, id: 'c-2', name: 'Maria Lopez', email: 'maria@example.com', login: 'marial' };
    const { app } = buildApp([CUSTOMER_BASE, other]);

    const res = await request(app).get('/api/internal/catalogs/clients').query({ page: 2, limit: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, page: 2, limit: 1 });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('c-2');
  });
});

describe('GET /api/internal/catalogs/clients/:id/contracts — no auth required', () => {
  it('returns the client contracts without any auth header/cookie', async () => {
    const { app } = buildApp([CUSTOMER_BASE], { 'c-1': [CONTRACT_BASE] });

    const res = await request(app).get('/api/internal/catalogs/clients/c-1/contracts');

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      {
        id: 'ct-1',
        code: 'GR-100',
        status: 'active',
        address: 'Calle Falsa 123',
        technology: 'Fiber',
        plan: '100MB',
        startDate: '2024-01-01T00:00:00.000Z',
      },
    ]);
    // Narrow DTO — services/lat/lng/vendedor never leak.
    expect(res.body.items[0]).not.toHaveProperty('services');
    expect(res.body.items[0]).not.toHaveProperty('lat');
  });

  it('returns {items: []} for a client with no contracts (GetClientContracts never throws)', async () => {
    const { app } = buildApp([CUSTOMER_BASE], {});

    const res = await request(app).get('/api/internal/catalogs/clients/c-1/contracts');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('returns {items: []} for a non-existent client id (same pass-through behavior)', async () => {
    const { app } = buildApp([CUSTOMER_BASE], { 'c-1': [CONTRACT_BASE] });

    const res = await request(app).get('/api/internal/catalogs/clients/does-not-exist/contracts');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });
});

describe('GET /api/internal/catalogs/projects — no auth required', () => {
  it('returns the project catalog without any auth header/cookie', async () => {
    const { app, projectRepo } = buildApp();
    const created = await projectRepo.create({ title: 'Instalaciones', visible: true });

    const res = await request(app).get('/api/internal/catalogs/projects');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: created.id, title: 'Instalaciones', visible: true });
  });

  it('?visible=true filters to only visible projects', async () => {
    const { app, projectRepo } = buildApp();
    await projectRepo.create({ title: 'Visible', visible: true });
    await projectRepo.create({ title: 'Oculto', visible: false });

    const res = await request(app).get('/api/internal/catalogs/projects').query({ visible: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('Visible');
  });
});

describe('GET /api/internal/catalogs/network-sites — no auth required', () => {
  it('returns the network site catalog without any auth header/cookie', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/internal/catalogs/network-sites');

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items[0]).toHaveProperty('siteNumber');
    expect(res.body.items[0]).toHaveProperty('name');
  });
});
