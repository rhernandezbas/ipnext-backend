/**
 * EPIC v3 (clave de TV del portal) — route-level coverage de
 * `GET /api/portal/tv/:contractId` + `PUT /api/portal/tv/:contractId/password`
 * sobre la app Express real + repos in-memory (molde `portalWifi.routes.test.ts`).
 *
 * El PUT usa `ChangePortalTvPassword` (fix wave W2): exige el slot TV ACTIVO
 * del CONTRATO del param (mismo resolver del GET) ANTES de tocar Gigared, y
 * delega en `ChangeTvPassword` (#65) — guard order pineado + anti-IDOR H1 (el
 * cic JAMÁS viene del request; se resuelve del propio customer, acá el
 * `clientId` DEL TOKEN). Contrato ajeno/inexistente -> 404 indistinguible SIN
 * tocar Gigared. Rate limiter dedicado 5/hora por cuenta (cada cambio pega en
 * la plataforma TV de un tercero).
 */
import express from 'express';
import request from 'supertest';

import { createPortalRouter } from '@infrastructure/http/routes/portal.routes';
import { createPortalAuthMiddleware } from '@infrastructure/http/middleware/portalAuthMiddleware';
import { createPortalKillSwitchMiddleware } from '@infrastructure/http/middleware/portalKillSwitchMiddleware';
import { createPortalGeneralRateLimiter, createPortalTvPasswordRateLimiter } from '@infrastructure/http/middleware/rateLimiters';

import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemorySettingsRepository } from '@infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { GetPortalTvStatus } from '@application/use-cases/portal/GetPortalTvStatus';
import { ChangePortalTvPassword } from '@application/use-cases/portal/ChangePortalTvPassword';
import { ChangeTvPassword } from '@application/use-cases/gigared/ChangeTvPassword';

import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import { GigaredNotFoundError } from '@domain/errors/gigared';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  return {
    cic: '0000001234', gigaredId: '2432', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [{ id: '129', name: 'Gigared Play Full' }],
    internalId: 'client-a', clientId: 'client-a', ott: null,
    ...over,
  };
}

function fakeGigaredPort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary: jest.fn(async () => ({ accounts: { registered: 0, unregistered: 0, total: 0 }, services: [] })),
    listAccounts: jest.fn(async () => []),
    getAccountByInternalId: jest.fn(async () => fakeAccount()),
    getAccountByCic: jest.fn(async () => fakeAccount()),
    register: jest.fn(async () => {}), activate: jest.fn(async () => {}), setInternalId: jest.fn(async () => {}),
    addService: jest.fn(async () => {}), removeService: jest.fn(async () => {}), setOtt: jest.fn(async () => {}),
    changePassword: jest.fn(async () => {}),
    renewCic: jest.fn(async () => ({ oldCic: '0000001234', newCic: '0000001235' })),
    ...over,
  };
}

async function buildStack(opts?: {
  gigared?: GigaredPort;
  /** contractId -> clientId dueño. */
  owners?: Record<string, string>;
  tvPasswordLimit?: number;
}) {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const settingsRepo = new InMemorySettingsRepository();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);

  const portalLogin = new PortalLogin(accounts, sessions, hasher, tokenService);
  const portalAuthMiddleware = createPortalAuthMiddleware(tokenService, accounts);
  const killSwitch = createPortalKillSwitchMiddleware(settingsRepo, 30_000);
  const generalRateLimiter = createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 1000 });
  const tvPasswordRateLimiter = createPortalTvPasswordRateLimiter({ windowMs: 60_000, limit: opts?.tvPasswordLimit ?? 5 });

  const owners = opts?.owners ?? { c1: 'client-a' };
  const contractLookup = { findById: async (id: string) => (owners[id] ? { id, clientId: owners[id]! } : null) };
  const customerLookup = { findById: async (id: string) => ({ id }) };

  const cs = new InMemoryContractServiceRepository();
  const catalog = new InMemoryServiceCatalogRepository();
  const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
  cs.catalog[cat.id] = { name: cat.name, label: cat.label };

  const gigared = opts?.gigared ?? fakeGigaredPort();
  const getPortalTvStatus = new GetPortalTvStatus(contractLookup, catalog, cs);
  // Fix wave W2 — el PUT del portal ya no llama a ChangeTvPassword directo:
  // el wrapper exige el slot TV activo del CONTRATO (mismo resolver del GET)
  // ANTES de tocar Gigared.
  const changePortalTvPassword = new ChangePortalTvPassword(
    getPortalTvStatus,
    new ChangeTvPassword(gigared, customerLookup, contractLookup, cs, catalog),
  );

  const app = express();
  app.use(express.json());
  app.use(
    '/api/portal',
    createPortalRouter({
      portalLogin,
      refreshPortalSession: { execute: async () => { throw new Error('not used'); } } as never,
      logoutPortal: { execute: async () => {} } as never,
      changePortalPassword: { execute: async () => {} } as never,
      portalAuthMiddleware,
      killSwitch,
      generalRateLimiter,
      tvPasswordRateLimiter,
      getPortalTvStatus,
      changePortalTvPassword,
    }),
  );

  return { app, accounts, hasher, cs, catalog, gigared, tvCatalogId: cat.id };
}

async function loginAs(app: express.Express, accounts: InMemoryPortalAccountRepository, hasher: InMemoryPasswordHasher, clientId: string): Promise<string> {
  const dni = `dni-${clientId}`;
  await accounts.create({ clientId, dni, passwordHash: await hasher.hash('Secret123') });
  const res = await request(app).post('/api/portal/auth/login').send({ dni, password: 'Secret123' });
  return res.body.accessToken as string;
}

describe('EPIC v3 — GET /api/portal/tv/:contractId', () => {
  it('contrato con TV -> 200 {hasTv:true, login} — nunca la password', async () => {
    const { app, accounts, hasher, cs, tvCatalogId } = await buildStack();
    await cs.add({ contractId: 'c1', serviceCatalogId: tvCatalogId, tvLogin: 'GIGA12345', tvPassword: 'ip243200' });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app).get('/api/portal/tv/c1').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasTv: true, login: 'GIGA12345' });
    expect(JSON.stringify(res.body)).not.toMatch(/ip243200/);
  });

  it('contrato SIN TV -> 200 {hasTv:false, login:null} (estado normal, no 404 — criterio elegibilidad WiFi)', async () => {
    const { app, accounts, hasher } = await buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app).get('/api/portal/tv/c1').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasTv: false, login: null });
  });

  it('anti-IDOR: contrato ajeno -> 404 INDISTINGUIBLE del inexistente (mismo body)', async () => {
    const { app, accounts, hasher, cs, tvCatalogId } = await buildStack({ owners: { c1: 'client-a', c2: 'client-b' } });
    await cs.add({ contractId: 'c2', serviceCatalogId: tvCatalogId, tvLogin: 'GIGA-DE-B' });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const resForeign = await request(app).get('/api/portal/tv/c2').set('Authorization', `Bearer ${token}`);
    const resMissing = await request(app).get('/api/portal/tv/no-existe').set('Authorization', `Bearer ${token}`);

    expect(resForeign.status).toBe(404);
    expect(resMissing.status).toBe(404);
    // Los mensajes difieren solo en el id PEDIDO (echo del request, no filtra
    // existencia) — code idéntico y jamás el login ajeno.
    expect(resForeign.body.code).toBe(resMissing.body.code);
    expect(JSON.stringify(resForeign.body)).not.toMatch(/GIGA-DE-B/);
  });

  it('sin token -> 401', async () => {
    const { app } = await buildStack();
    const res = await request(app).get('/api/portal/tv/c1');
    expect(res.status).toBe(401);
  });
});

describe('EPIC v3 — PUT /api/portal/tv/:contractId/password', () => {
  it('happy path: 200 {applied:true} EXACTO (nunca ecoa la password) y reusa ChangeTvPassword con el clientId DEL TOKEN', async () => {
    const gigared = fakeGigaredPort({ getAccountByInternalId: jest.fn(async () => fakeAccount({ cic: '0000009999' })) });
    const { app, accounts, hasher, cs, tvCatalogId } = await buildStack({ gigared });
    await cs.add({ contractId: 'c1', serviceCatalogId: tvCatalogId, tvLogin: 'GIGA12345' });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app)
      .put('/api/portal/tv/c1/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'clave1234' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: true });
    // H1: la cuenta se resolvió del cliente del TOKEN, y el PATCH fue a SU cic.
    expect(gigared.getAccountByInternalId).toHaveBeenCalledWith('client-a');
    expect(gigared.changePassword).toHaveBeenCalledWith('0000009999', 'clave1234');
    // El use case persistió el snapshot local en el slot TV (M5).
    const slot = await cs.getByPair('c1', tvCatalogId);
    expect(slot!.tvPassword).toBe('clave1234');
  });

  it('política CUA: password inválida -> 400 TV_PASSWORD_POLICY, Gigared JAMÁS tocado', async () => {
    // Fixture actualizado por W2: el original NO tenía slot TV en c1 (fixture
    // degenerado — probaba la política sobre un contrato que hoy 404ea antes).
    // Con el slot presente, el guard bajo prueba sigue siendo la política CUA.
    const { app, accounts, hasher, gigared, cs, tvCatalogId } = await buildStack();
    await cs.add({ contractId: 'c1', serviceCatalogId: tvCatalogId, tvLogin: 'GIGA12345' });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app)
      .put('/api/portal/tv/c1/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'MAYUS-NO!' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TV_PASSWORD_POLICY');
    expect(gigared.getAccountByInternalId).not.toHaveBeenCalled();
    expect(gigared.changePassword).not.toHaveBeenCalled();
  });

  it('anti-IDOR: contrato ajeno -> 404 SIN tocar Gigared (guard order de ChangeTvPassword)', async () => {
    const { app, accounts, hasher, gigared } = await buildStack({ owners: { c1: 'client-a', c2: 'client-b' } });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const resForeign = await request(app)
      .put('/api/portal/tv/c2/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'clave1234' });
    const resMissing = await request(app)
      .put('/api/portal/tv/no-existe/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'clave1234' });

    expect(resForeign.status).toBe(404);
    expect(resMissing.status).toBe(404);
    expect(resForeign.body.code).toBe(resMissing.body.code);
    expect(gigared.getAccountByInternalId).not.toHaveBeenCalled();
    expect(gigared.changePassword).not.toHaveBeenCalled();
  });

  it('cliente sin cuenta TV vinculada (404 upstream) -> 404 TV_NOT_LINKED, password nunca cambiada', async () => {
    const gigared = fakeGigaredPort({
      getAccountByInternalId: jest.fn(async () => { throw new GigaredNotFoundError(); }),
    });
    // Fixture actualizado por W2: sin slot TV local el pre-check 404ea ANTES de
    // Gigared y este test dejaba de ejercitar el camino del 404 UPSTREAM
    // (slot local presente pero cuenta Gigared inexistente = drift real).
    const { app, accounts, hasher, cs, tvCatalogId } = await buildStack({ gigared });
    await cs.add({ contractId: 'c1', serviceCatalogId: tvCatalogId, tvLogin: 'GIGA12345' });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app)
      .put('/api/portal/tv/c1/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'clave1234' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TV_NOT_LINKED');
    expect(gigared.changePassword).not.toHaveBeenCalled();
  });

  /**
   * Fix wave W2 — el PUT exigía solo ownership: con un contrato PROPIO pero SIN
   * TV, el PATCH a Gigared salía igual (la cuenta es per-customer) y el snapshot
   * local del contrato que SÍ tiene TV quedaba stale en silencio. El camino del
   * portal exige el slot TV ACTIVO del CONTRATO del param (mismo resolver que el
   * GET) ANTES de tocar Gigared.
   */
  it('W2: contrato propio SIN TV -> 404 TV_NOT_LINKED y Gigared JAMÁS tocado', async () => {
    const { app, accounts, hasher, gigared } = await buildStack({ owners: { 'c-sin-tv': 'client-a' } });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app)
      .put('/api/portal/tv/c-sin-tv/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'clave1234' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TV_NOT_LINKED');
    expect(gigared.getAccountByInternalId).not.toHaveBeenCalled();
    expect(gigared.changePassword).not.toHaveBeenCalled();
  });

  it('W2: contrato propio SIN slot ACTIVO (baja) -> 404 TV_NOT_LINKED, Gigared intacto', async () => {
    const { app, accounts, hasher, gigared, cs, tvCatalogId } = await buildStack();
    await cs.add({ contractId: 'c1', serviceCatalogId: tvCatalogId, tvLogin: 'GIGA12345' });
    const slot = await cs.getByPair('c1', tvCatalogId);
    await cs.update(slot!.id, { status: 'inactive' });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app)
      .put('/api/portal/tv/c1/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'clave1234' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TV_NOT_LINKED');
    expect(gigared.changePassword).not.toHaveBeenCalled();
  });

  /** Fix wave S1 — schema zod `.strict()` como los hermanos: campo extra -> 400. */
  it('S1: campo extra en el body -> 400 VALIDATION_ERROR (schema .strict())', async () => {
    const { app, accounts, hasher, cs, tvCatalogId, gigared } = await buildStack();
    await cs.add({ contractId: 'c1', serviceCatalogId: tvCatalogId, tvLogin: 'GIGA12345' });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app)
      .put('/api/portal/tv/c1/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'clave1234', cic: '0000009999' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(gigared.changePassword).not.toHaveBeenCalled();
  });

  it('body sin password -> 400 VALIDATION_ERROR', async () => {
    const { app, accounts, hasher } = await buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const res = await request(app).put('/api/portal/tv/c1/password').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rate limit dedicado (molde wifi update, 5/hora por cuenta): el 6to cambio -> 429', async () => {
    // Fixture actualizado por W2: los 5 cambios "200" necesitan el slot TV
    // (el fixture original sin slot era degenerado — hoy daría 404 x5).
    const { app, accounts, hasher, cs, tvCatalogId } = await buildStack({ tvPasswordLimit: 5 });
    await cs.add({ contractId: 'c1', serviceCatalogId: tvCatalogId, tvLogin: 'GIGA12345' });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .put('/api/portal/tv/c1/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'clave1234' });
      expect(res.status).toBe(200);
    }
    const sixth = await request(app)
      .put('/api/portal/tv/c1/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'clave1234' });
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('RATE_LIMITED');
  });
});
