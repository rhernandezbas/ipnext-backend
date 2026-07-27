import express from 'express';
import request from 'supertest';
import type { RequestHandler } from 'express';
import { createTechnicianLocationRouter } from '@infrastructure/http/routes/technicianLocation.routes';
import { InMemoryTeamLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryTeamLocationRepository';
import { GetTeamsLiveStatus } from '@application/use-cases/GetTeamsLiveStatus';
import { GetTeamDailyJourney } from '@application/use-cases/GetTeamDailyJourney';
import { AuditServiceOrderPresence } from '@application/use-cases/AuditServiceOrderPresence';
import { ListSuspiciousClosures } from '@application/use-cases/ListSuspiciousClosures';
import type { TeamLocationSource } from '@domain/ports/TeamLocationSource';
import type { ClosedServiceOrderSummary, SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';

const NOW = new Date('2026-07-26T12:45:00Z');

const allow: RequestHandler = (_req, _res, next) => next();
const deny: RequestHandler = (_req, res) => {
  res.status(403).json({ error: 'forbidden' });
};

const source: TeamLocationSource = {
  async listTeams() {
    return [{ login: 'IPNXANDYM', name: 'Andy Medina', externalId: '1', status: 'Inativo' }];
  },
  async listTeamLocations() {
    return { points: [], pagesRead: 0, incomplete: false, pointsDropped: 0 };
  },
  async getLastTeamLocation() {
    return null;
  },
};

const historyEv = (iso: string, statusDescription: string): SoStatusHistoryEntry => ({
  iclassOsStatusId: 'x',
  occurredAt: iso,
  statusCode: '0',
  statusDescription,
  durationMinutes: null,
  teamLogin: 'IPNXANDYM',
  commentary: null,
});

function order(): ClosedServiceOrderSummary {
  return {
    iclassId: '1', iclassCodigo: '4995', clusterName: 'IPNEXT INTERNET',
    thirdPartyCode: null, nodeCode: null, soTypeId: null, soTypeDescription: 'RETIROS',
    customerCode: null, customerName: 'Cliente', addressCode: null, addressLine: 'Calle 1',
    addressCity: null, addressLat: -34.70084, addressLng: -59.32028,
    statusCode: '7', statusDescription: 'Concluida',
    requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: 'Cliente Ausente.', closedByLogin: null, closedByName: null,
    closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: null,
    technicianNote: null, internalNote: null, commentaryLog: null,
    teamLogin: 'IPNXANDYM', teamTechnicianName: 'Andy Medina', teamPhone: null, teamEmail: null,
    iclassCreatedAt: null, iclassUpdatedAt: null, rawDetail: {},
  };
}

const iclass = {
  listServiceOrders: jest.fn(async () => [order()]),
  getServiceOrderHistory: jest.fn(async () => [
    historyEv('2026-07-01T23:29:02.000Z', 'DESLOCAMENTO'),
    historyEv('2026-07-01T23:31:18.000Z', 'FECHADA'),
  ]),
};

function makeApp(opts: { requireRead: RequestHandler; requireAudit: RequestHandler }) {
  const repo = new InMemoryTeamLocationRepository();
  const app = express();
  app.use(express.json());
  app.use(
    '/api/technicians',
    createTechnicianLocationRouter({
      getTeamsLiveStatus: new GetTeamsLiveStatus({ repo, source, now: () => NOW }),
      getTeamDailyJourney: new GetTeamDailyJourney({ repo }),
      auditServiceOrderPresence: new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }),
      listSuspiciousClosures: new ListSuspiciousClosures({ iclass }),
      requireLocationRead: opts.requireRead,
      requireLocationAudit: opts.requireAudit,
    }),
  );
  return { app, repo };
}

describe('technicianLocation.routes — permission gating (two SEPARATE permissions)', () => {
  it('GET /live is allowed with location_read', async () => {
    const { app } = makeApp({ requireRead: allow, requireAudit: deny });
    const res = await request(app).get('/api/technicians/live');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /live is REJECTED by the backend without location_read', async () => {
    const { app } = makeApp({ requireRead: deny, requireAudit: allow });
    const res = await request(app).get('/api/technicians/live');
    expect(res.status).toBe(403);
  });

  it('location_read alone does NOT open the audit endpoint (BACKEND rejection, not just FE)', async () => {
    // La regla clave: quien despacha NO puede auditar el historial de una persona.
    const { app } = makeApp({ requireRead: allow, requireAudit: deny });

    const audit = await request(app).get('/api/technicians/audit/service-order/4995');
    expect(audit.status).toBe(403);

    const suspicious = await request(app).get(
      '/api/technicians/audit/suspicious-closures?from=2026-07-23&to=2026-07-26',
    );
    expect(suspicious.status).toBe(403);
  });

  it('location_audit alone does NOT open the live map', async () => {
    const { app } = makeApp({ requireRead: deny, requireAudit: allow });
    expect((await request(app).get('/api/technicians/live')).status).toBe(403);
    expect((await request(app).get('/api/technicians/audit/service-order/4995')).status).toBe(200);
  });

  it('GET /:login/journey is gated by location_read', async () => {
    const { app } = makeApp({ requireRead: deny, requireAudit: allow });
    const res = await request(app).get('/api/technicians/IPNXANDYM/journey?day=2026-07-26');
    expect(res.status).toBe(403);
  });
});

describe('technicianLocation.routes — payloads', () => {
  it('GET /live returns the roster with its freshness state', async () => {
    const { app } = makeApp({ requireRead: allow, requireAudit: allow });
    const res = await request(app).get('/api/technicians/live');
    expect(res.status).toBe(200);
    expect(res.body.data[0].login).toBe('IPNXANDYM');
    expect(res.body.data[0].state).toBe('SIN_RASTRO');
  });

  it('GET /audit/service-order/:code returns the verdict WITH its evidence', async () => {
    const { app } = makeApp({ requireRead: allow, requireAudit: allow });
    const res = await request(app).get('/api/technicians/audit/service-order/4995');

    expect(res.status).toBe(200);
    const body = res.body.data;
    expect(body.verdict).toBe('NO_CONCLUYENTE');
    // La evidencia viaja SIEMPRE con el veredicto.
    expect(body).toHaveProperty('pointsEvaluated');
    expect(body).toHaveProperty('window');
    expect(body).toHaveProperty('onSiteThresholdMeters');
    expect(body).toHaveProperty('reason');
  });

  it('GET /:login/journey validates the day format', async () => {
    const { app } = makeApp({ requireRead: allow, requireAudit: allow });
    const res = await request(app).get('/api/technicians/IPNXANDYM/journey?day=26-07-2026');
    expect(res.status).toBe(400);
  });

  it('GET /audit/suspicious-closures requires a valid date range', async () => {
    const { app } = makeApp({ requireRead: allow, requireAudit: allow });
    const res = await request(app).get('/api/technicians/audit/suspicious-closures');
    expect(res.status).toBe(400);
  });

  it('GET /audit/suspicious-closures returns candidates, never verdicts', async () => {
    const { app } = makeApp({ requireRead: allow, requireAudit: allow });
    const res = await request(app).get(
      '/api/technicians/audit/suspicious-closures?from=2026-07-23&to=2026-07-26',
    );
    expect(res.status).toBe(200);
    expect(res.body.data[0].isCandidateForReview).toBe(true);
    expect(res.body.data[0]).not.toHaveProperty('verdict');
  });
});
