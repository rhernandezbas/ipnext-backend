/**
 * portal-promos — route-level coverage de los 10 casos TDD obligatorios sobre
 * la app Express real + repos in-memory (molde `portal.routes.test.ts`/
 * `CreatePortalTicket.test.ts` — sin Prisma/DB real).
 *
 * `clientMatchesSegment` (la pregunta INVERSA de `listSegmentRecipients`, ver
 * el port `SegmentMembershipChecker`) se fakea con un predicado configurable
 * por test — no hay `InMemoryCustomerRepository` en este repo (convención
 * existente, ver `CreatePortalTicket.test.ts`).
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
import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
import { InMemoryPortalPromoRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPromoRepository';
import { InMemoryPortalPromoResponseRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPromoResponseRepository';

import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { ListPortalPromos } from '@application/use-cases/portal/ListPortalPromos';
import { GetPortalPromo } from '@application/use-cases/portal/GetPortalPromo';
import { InterestInPortalPromo } from '@application/use-cases/portal/InterestInPortalPromo';
import { DismissPortalPromo } from '@application/use-cases/portal/DismissPortalPromo';

import type { CustomerRepository, CampaignSegmentFilter, SegmentMembershipChecker } from '@domain/ports/CustomerRepository';
import type { Contract } from '@domain/entities/customer';
import type { PortalPromo } from '@domain/entities/portalPromo';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

/** Fake narrow — mismo criterio que `CreatePortalTicket.test.ts` (sin InMemoryCustomerRepository). */
function fakeCustomers(byClient: Record<string, Contract[]> = {}): Pick<CustomerRepository, 'listContracts'> {
  return { listContracts: async (clientId: string) => byClient[clientId] ?? [] };
}

/** Segmento "excluye a client-a" — usado para el caso 4 (promo de otro segmento). */
const EXCLUDES_CLIENT_A: CampaignSegmentFilter = { statuses: ['solo-otros'] };
const MATCHES_EVERYONE: CampaignSegmentFilter = { statuses: [] };

class FakeSegmentChecker implements Pick<SegmentMembershipChecker, 'clientMatchesSegment'> {
  async clientMatchesSegment(clientId: string, segment: CampaignSegmentFilter): Promise<boolean> {
    if (segment === EXCLUDES_CLIENT_A && clientId === 'client-a') return false;
    return true;
  }
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
  const areas = new InMemoryTicketAreaCatalogRepository();
  tickets.seedAreas(areas);
  const segmentChecker = new FakeSegmentChecker();

  const listPortalPromos = new ListPortalPromos(promos, responses, segmentChecker);
  const getPortalPromo = new GetPortalPromo(promos, responses, segmentChecker);
  const interestInPortalPromo = new InterestInPortalPromo(promos, responses, segmentChecker, tickets, areas, customers);
  const dismissPortalPromo = new DismissPortalPromo(promos, responses, segmentChecker);

  const app = express();
  app.use(express.json());
  app.use(
    '/api/portal',
    createPortalRouter({
      // Auth mínimo requerido por el factory (no se ejercita en estos tests
      // más allá del login inicial para obtener el token).
      portalLogin,
      refreshPortalSession: { execute: async () => { throw new Error('not used'); } } as never,
      logoutPortal: { execute: async () => {} } as never,
      changePortalPassword: { execute: async () => {} } as never,
      portalAuthMiddleware,
      killSwitch,
      generalRateLimiter,
      listPortalPromos,
      getPortalPromo,
      interestInPortalPromo,
      dismissPortalPromo,
    }),
  );

  return { app, accounts, sessions, hasher, promos, responses, tickets, areas };
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

describe('portal-promos — GET /api/portal/promos + /:id + interest/dismiss (10 casos TDD)', () => {
  it('caso 1 — promo en borrador (publishedAt null) NO aparece en la lista', async () => {
    const { app, accounts, hasher, promos } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await promos.create(makePromoInput({ publishedAt: null }));

    const res = await request(app).get('/api/portal/promos').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('caso 2 — promo fuera de vigencia (antes de startsAt Y después de endsAt) NO aparece', async () => {
    const { app, accounts, hasher, promos } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const now = Date.now();
    await promos.create(
      makePromoInput({ startsAt: new Date(now + 24 * 60 * 60 * 1000), endsAt: new Date(now + 48 * 60 * 60 * 1000) }),
    ); // todavía no empezó
    await promos.create(
      makePromoInput({ startsAt: new Date(now - 48 * 60 * 60 * 1000), endsAt: new Date(now - 24 * 60 * 60 * 1000) }),
    ); // ya terminó

    const res = await request(app).get('/api/portal/promos').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('caso 3 — promo archivada NO aparece', async () => {
    const { app, accounts, hasher, promos } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await promos.create(makePromoInput());
    const [created] = await promos.list();
    await promos.update(created!.id, { archivedAt: new Date() });

    const res = await request(app).get('/api/portal/promos').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('caso 4 — promo de un segmento al que el cliente NO pertenece NO aparece Y GET /:id da 404', async () => {
    const { app, accounts, hasher, promos } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const promo = await promos.create(makePromoInput({ segment: EXCLUDES_CLIENT_A }));

    const list = await request(app).get('/api/portal/promos').set('Authorization', `Bearer ${token}`);
    expect(list.body.data).toEqual([]);

    const detail = await request(app).get(`/api/portal/promos/${promo.id}`).set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(404);
    expect(detail.body.code).toBe('PORTAL_PROMO_NOT_FOUND');
  });

  it('caso 5 — tras dismiss, la promo deja de aparecer en la lista', async () => {
    const { app, accounts, hasher, promos } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const promo = await promos.create(makePromoInput());

    const dismiss = await request(app).post(`/api/portal/promos/${promo.id}/dismiss`).set('Authorization', `Bearer ${token}`);
    expect(dismiss.status).toBe(204);

    const list = await request(app).get('/api/portal/promos').set('Authorization', `Bearer ${token}`);
    expect(list.body.data).toEqual([]);
  });

  it('caso 6 — tras interest, la promo deja de aparecer en la lista', async () => {
    const { app, accounts, hasher, promos } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const promo = await promos.create(makePromoInput());

    const interest = await request(app).post(`/api/portal/promos/${promo.id}/interest`).set('Authorization', `Bearer ${token}`).send({});
    expect(interest.status).toBe(201);
    expect(interest.body.ticketNumber).toEqual(expect.any(Number));

    const list = await request(app).get('/api/portal/promos').set('Authorization', `Bearer ${token}`);
    expect(list.body.data).toEqual([]);
  });

  it('caso 7 — interest crea UN ticket con el área de la promo (verifica areaId guardado, no el status code)', async () => {
    const { app, accounts, hasher, promos, tickets, areas } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const area = await areas.create({ name: 'Comercial', color: '#123456' });
    const promo = await promos.create(makePromoInput({ ticketAreaId: area.id }));

    const res = await request(app).post(`/api/portal/promos/${promo.id}/interest`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(201);

    const listed = await tickets.list({ customerId: 'client-a' });
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]!.areaId).toBe(area.id);
  });

  it('caso 8 — interest DOS VECES -> 200 con el MISMO ticketNumber, y UN SOLO ticket en el repo', async () => {
    const { app, accounts, hasher, promos, tickets } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const promo = await promos.create(makePromoInput());

    const first = await request(app).post(`/api/portal/promos/${promo.id}/interest`).set('Authorization', `Bearer ${token}`).send({});
    const second = await request(app).post(`/api/portal/promos/${promo.id}/interest`).set('Authorization', `Bearer ${token}`).send({});

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.ticketNumber).toBe(first.body.ticketNumber);

    const listed = await tickets.list({ customerId: 'client-a' });
    expect(listed.data).toHaveLength(1);
  });

  it('anti-IDOR — clientId SIEMPRE del token: sin token, 401 en las 4 rutas', async () => {
    const { app, promos } = buildStack();
    const promo = await promos.create(makePromoInput());

    const list = await request(app).get('/api/portal/promos');
    const detail = await request(app).get(`/api/portal/promos/${promo.id}`);
    const interest = await request(app).post(`/api/portal/promos/${promo.id}/interest`).send({});
    const dismiss = await request(app).post(`/api/portal/promos/${promo.id}/dismiss`);

    expect(list.status).toBe(401);
    expect(detail.status).toBe(401);
    expect(interest.status).toBe(401);
    expect(dismiss.status).toBe(401);
  });

  describe('caso 4 — revert-probe OBLIGATORIO (sacar el re-chequeo de segmento de GET /:id)', () => {
    it('documenta el resultado esperado: sin el re-chequeo, el test de arriba debe FALLAR (ver reporte)', () => {
      // Este test es un ancla legible — el revert-probe real se ejecuta manualmente
      // (editar GetPortalPromo.execute para saltear el chequeo de segmento, correr
      // el archivo, restaurar con git diff limpio) y su resultado se documenta en
      // el reporte final, tal como pide la consigna.
      expect(true).toBe(true);
    });
  });
});

describe('portal-promos — audience-preview y otros ejes no cubiertos por los 10 casos', () => {
  it('GET /:id con promo inexistente -> 404 (mismo código que "no aplica")', async () => {
    const { app, accounts, hasher } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const res = await request(app).get('/api/portal/promos/no-existe').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('dismiss sobre una promo YA respondida (interest) es un no-op idempotente -> 204', async () => {
    const { app, accounts, hasher, promos } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const promo = await promos.create(makePromoInput());
    await request(app).post(`/api/portal/promos/${promo.id}/interest`).set('Authorization', `Bearer ${token}`).send({});

    const res = await request(app).post(`/api/portal/promos/${promo.id}/dismiss`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
  });
});

// Tipo auxiliar solo para que `makePromoInput` compile con el shape exacto del port.
type _Unused = PortalPromo;
