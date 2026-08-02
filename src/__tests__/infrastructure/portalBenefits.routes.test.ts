/**
 * portal-benefits — route-level coverage de los 8 casos TDD obligatorios
 * sobre la app Express real + repos in-memory (molde `portalPromos.routes.
 * test.ts` — sin Prisma/DB real).
 *
 * `clientMatchesSegment` se fakea con un predicado configurable por test —
 * no hay `InMemoryCustomerRepository` en este repo (misma convención que
 * `portalPromos.routes.test.ts`/`CreatePortalTicket.test.ts`).
 */
import express from 'express';
import request from 'supertest';

import { createPortalRouter } from '@infrastructure/http/routes/portal.routes';
import { createPortalAuthMiddleware } from '@infrastructure/http/middleware/portalAuthMiddleware';
import { createPortalKillSwitchMiddleware } from '@infrastructure/http/middleware/portalKillSwitchMiddleware';
import { createPortalGeneralRateLimiter } from '@infrastructure/http/middleware/rateLimiters';

import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemorySettingsRepository } from '@infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryPortalPromoRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPromoRepository';
import { InMemoryPortalPromoResponseRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPromoResponseRepository';

import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { ListPortalBenefits } from '@application/use-cases/portal/ListPortalBenefits';

import type { CustomerRepository, CampaignSegmentFilter, SegmentMembershipChecker } from '@domain/ports/CustomerRepository';
import type { Contract } from '@domain/entities/customer';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

/** Segmento "excluye a client-a" — usado para el caso 3 (promo de otro segmento). */
const EXCLUDES_CLIENT_A: CampaignSegmentFilter = { statuses: ['solo-otros'] };
const MATCHES_EVERYONE: CampaignSegmentFilter = { statuses: [] };

class FakeSegmentChecker implements Pick<SegmentMembershipChecker, 'clientMatchesSegment'> {
  async clientMatchesSegment(clientId: string, segment: CampaignSegmentFilter): Promise<boolean> {
    if (segment === EXCLUDES_CLIENT_A && clientId === 'client-a') return false;
    return true;
  }
}

function makeContract(overrides: Partial<Contract> & { id: string }): Contract {
  return {
    code: null,
    type: 'internet',
    plan: '300 Mb',
    ip: '10.0.0.1',
    status: 'active',
    startDate: '2025-01-01T00:00:00.000Z',
    endDate: '',
    address: null,
    lat: null,
    lng: null,
    technology: null,
    name: null,
    vendedor: null,
    services: [],
    ...overrides,
  };
}

/** Fake narrow — mismo criterio que `portalPromos.routes.test.ts` (sin InMemoryCustomerRepository). */
function fakeCustomers(byClient: Record<string, Contract[]> = {}): Pick<CustomerRepository, 'listContracts'> {
  return { listContracts: async (clientId: string) => byClient[clientId] ?? [] };
}

function makePromoInput(overrides: Partial<Parameters<InMemoryPortalPromoRepository['create']>[0]> = {}) {
  const now = Date.now();
  return {
    title: 'Fibra 300 Mb',
    summary: 'Upgrade gratis por 3 meses',
    body: 'Detalle completo de la promo de fibra.',
    ctaLabel: 'Me interesa',
    segment: MATCHES_EVERYONE,
    startsAt: new Date(now - 24 * 60 * 60 * 1000), // ayer
    endsAt: new Date(now + 24 * 60 * 60 * 1000), // mañana
    publishedAt: new Date(now - 60 * 60 * 1000), // hace 1h
    authorId: null,
    authorName: 'Operador',
    ...overrides,
  };
}

function buildStack(customers: Pick<CustomerRepository, 'listContracts'> = fakeCustomers()) {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const settingsRepo = new InMemorySettingsRepository();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);

  const portalLogin = new PortalLogin(accounts, sessions, hasher, tokenService);
  const portalAuthMiddleware = createPortalAuthMiddleware(tokenService, accounts);
  const killSwitch = createPortalKillSwitchMiddleware(settingsRepo, 30_000);
  const generalRateLimiter = createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 1000 });

  const promos = new InMemoryPortalPromoRepository();
  const responses = new InMemoryPortalPromoResponseRepository();
  const tickets = new InMemoryTicketRepository();
  const segmentChecker = new FakeSegmentChecker();

  const listPortalBenefits = new ListPortalBenefits(promos, responses, segmentChecker, customers, tickets);

  const app = express();
  app.use(express.json());
  app.use(
    '/api/portal',
    createPortalRouter({
      // Auth mínimo requerido por el factory (no se ejercita más allá del
      // login inicial para obtener el token).
      portalLogin,
      refreshPortalSession: { execute: async () => { throw new Error('not used'); } } as never,
      logoutPortal: { execute: async () => {} } as never,
      changePortalPassword: { execute: async () => {} } as never,
      portalAuthMiddleware,
      killSwitch,
      generalRateLimiter,
      listPortalBenefits,
    }),
  );

  return { app, accounts, hasher, promos, responses, tickets };
}

async function loginAs(
  app: express.Express,
  accounts: InMemoryPortalAccountRepository,
  hasher: InMemoryPasswordHasher,
  clientId: string,
): Promise<string> {
  const dni = `dni-${clientId}`;
  await accounts.create({ clientId, dni, passwordHash: await hasher.hash('Secret123') });
  const res = await request(app).post('/api/portal/auth/login').send({ dni, password: 'Secret123' });
  return res.body.accessToken as string;
}

describe('portal-benefits — GET /api/portal/benefits (8 casos TDD)', () => {
  it('caso 1 — una promo DESCARTADA sigue apareciendo en available (el punto de todo el change)', async () => {
    const { app, accounts, hasher, promos, responses } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const promo = await promos.create(makePromoInput({ title: 'Subí a 600MB' }));
    await responses.create({ promoId: promo.id, clientId: 'client-a', kind: 'dismissed' });

    const res = await request(app).get('/api/portal/benefits').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.available).toEqual([
      expect.objectContaining({ id: promo.id, title: 'Subí a 600MB' }),
    ]);
  });

  it('caso 2 — una promo ACEPTADA NO aparece en available y SÍ en active, con el número de ticket', async () => {
    const { app, accounts, hasher, promos, responses, tickets } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const promo = await promos.create(makePromoInput({ title: 'Subí a 600MB' }));
    const ticket = await tickets.create({
      subject: 'Me interesa: Subí a 600MB',
      description: 'El cliente expresó interés',
      customerId: 'client-a',
    });
    await responses.create({ promoId: promo.id, clientId: 'client-a', kind: 'interested', ticketId: ticket.id });

    const res = await request(app).get('/api/portal/benefits').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.available).toEqual([]);
    expect(res.body.active).toEqual([
      expect.objectContaining({ kind: 'promo', title: 'Subí a 600MB', detail: `Reclamo #${ticket.sequenceNumber}` }),
    ]);
  });

  it('caso 3 — una promo de OTRO segmento no aparece en ninguna de las dos listas', async () => {
    const { app, accounts, hasher, promos } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await promos.create(makePromoInput({ segment: EXCLUDES_CLIENT_A }));

    const res = await request(app).get('/api/portal/benefits').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.available).toEqual([]);
    expect(res.body.active).toEqual([]);
  });

  it('caso 4 — promo vencida, archivada o en borrador no aparece en available', async () => {
    const { app, accounts, hasher, promos } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const now = Date.now();

    // vencida
    await promos.create(makePromoInput({
      startsAt: new Date(now - 48 * 60 * 60 * 1000),
      endsAt: new Date(now - 24 * 60 * 60 * 1000),
    }));
    // archivada
    const archived = await promos.create(makePromoInput());
    await promos.update(archived.id, { archivedAt: new Date() });
    // en borrador
    await promos.create(makePromoInput({ publishedAt: null }));

    const res = await request(app).get('/api/portal/benefits').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.available).toEqual([]);
  });

  it('caso 5 — active trae los servicios de contratos ACTIVOS y NO los de un contrato dado de baja', async () => {
    const customers = fakeCustomers({
      'client-a': [
        makeContract({
          id: 'c-active-1', status: 'active', plan: '300 Mb',
          services: [
            { id: 's1', serviceCatalogId: 'sc1', name: 'INTERNET', label: null, status: 'active', notes: null, createdAt: '2025-01-01T00:00:00.000Z' },
          ],
        }),
        makeContract({
          id: 'c-active-2', status: 'active', plan: 'TV Full',
          services: [
            { id: 's2', serviceCatalogId: 'sc2', name: 'TV', label: null, status: 'active', notes: null, createdAt: '2025-02-01T00:00:00.000Z' },
          ],
        }),
        makeContract({
          id: 'c-baja-1', status: 'baja', plan: '100 Mb (baja)',
          services: [
            { id: 's3', serviceCatalogId: 'sc3', name: 'INTERNET-BAJA', label: null, status: 'active', notes: null, createdAt: '2024-01-01T00:00:00.000Z' },
          ],
        }),
        makeContract({
          id: 'c-baja-2', status: 'baja', plan: 'TV (baja)',
          services: [
            { id: 's4', serviceCatalogId: 'sc4', name: 'TV-BAJA', label: null, status: 'active', notes: null, createdAt: '2024-02-01T00:00:00.000Z' },
          ],
        }),
      ],
    });
    const { app, accounts, hasher } = buildStack(customers);
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app).get('/api/portal/benefits').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const serviceTitles = (res.body.active as Array<{ kind: string; title: string }>)
      .filter((e) => e.kind === 'service')
      .map((e) => e.title);
    expect(serviceTitles.sort()).toEqual(['INTERNET', 'TV']);
  });

  it('caso 6 — tenure sale del startDate MÁS VIEJO entre >=2 contratos de fechas distintas', async () => {
    const customers = fakeCustomers({
      'client-a': [
        makeContract({ id: 'c1', startDate: '2025-09-10T00:00:00.000Z' }),
        makeContract({ id: 'c2', startDate: '2023-03-05T00:00:00.000Z' }), // el más viejo
      ],
    });
    const { app, accounts, hasher } = buildStack(customers);
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app).get('/api/portal/benefits').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const tenure = (res.body.active as Array<{ kind: string; title: string; since: string }>).find(
      (e) => e.kind === 'tenure',
    );
    expect(tenure).toBeDefined();
    expect(tenure!.title).toBe('Cliente desde marzo 2023');
    expect(tenure!.since).toBe('2023-03-05T00:00:00.000Z');
  });

  it('caso 7 — cliente SIN contratos: sin tenure y sin service, 200 con listas coherentes (no 500)', async () => {
    const { app, accounts, hasher } = buildStack(fakeCustomers({ 'client-a': [] }));
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app).get('/api/portal/benefits').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.available).toEqual([]);
    expect(res.body.active).toEqual([]);
  });

  it('caso 8 — anti-IDOR: un cliente no ve nada de otro (promos aceptadas + contratos)', async () => {
    const customers = fakeCustomers({
      'client-b': [makeContract({ id: 'cb', plan: 'Solo de B', services: [
        { id: 'sb', serviceCatalogId: 'scb', name: 'INTERNET-B', label: null, status: 'active', notes: null, createdAt: '2025-01-01T00:00:00.000Z' },
      ] })],
    });
    const { app, accounts, hasher, promos, responses, tickets } = buildStack(customers);
    const tokenA = await loginAs(app, accounts, hasher, 'client-a');
    await loginAs(app, accounts, hasher, 'client-b');

    const promo = await promos.create(makePromoInput({ title: 'Promo de B' }));
    const ticket = await tickets.create({ subject: 'x', description: 'y', customerId: 'client-b' });
    await responses.create({ promoId: promo.id, clientId: 'client-b', kind: 'interested', ticketId: ticket.id });

    const res = await request(app).get('/api/portal/benefits').set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    // client-a NO vio la promo aceptada por B, y NO ve los contratos/servicios de B.
    expect(res.body.active).toEqual([]);
    // la promo de B (aceptada por B, no por A) SÍ está disponible para A (nadie de A la respondió).
    expect(res.body.available).toEqual([expect.objectContaining({ title: 'Promo de B' })]);
  });

  it('sin token -> 401', async () => {
    const { app } = buildStack();
    const res = await request(app).get('/api/portal/benefits');
    expect(res.status).toBe(401);
  });
});
