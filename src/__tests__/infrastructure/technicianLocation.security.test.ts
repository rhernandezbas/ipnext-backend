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

/**
 * Hallazgos 3.1 / 3.3 / 3.4 / 3.5 / 3.6 / 3.7 del review adversarial de seguridad.
 *
 * El dato que exponen estas rutas es la UBICACIÓN DE EMPLEADOS, con implicancias
 * laborales. Cada test de acá representa una capacidad que un usuario NO debe tener.
 */

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
    customerCode: null, customerName: 'FERNANDEZ MARIA CRISTINA', addressCode: null,
    addressLine: 'Plaza Silvano de Jofre',
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

function makeApp(opts: {
  requireRead?: RequestHandler;
  requireAudit?: RequestHandler;
  iclassOverride?: { listServiceOrders: jest.Mock; getServiceOrderHistory: jest.Mock };
}) {
  const repo = new InMemoryTeamLocationRepository();
  const iclass = opts.iclassOverride ?? {
    listServiceOrders: jest.fn(async () => [order()]),
    getServiceOrderHistory: jest.fn(async () => [
      historyEv('2026-07-01T23:29:02.000Z', 'DESLOCAMENTO'),
      historyEv('2026-07-01T23:31:18.000Z', 'FECHADA'),
    ]),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/technicians',
    createTechnicianLocationRouter({
      getTeamsLiveStatus: new GetTeamsLiveStatus({ repo, source, now: () => NOW }),
      getTeamDailyJourney: new GetTeamDailyJourney({ repo }),
      auditServiceOrderPresence: new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }),
      listSuspiciousClosures: new ListSuspiciousClosures({ iclass }),
      requireLocationRead: opts.requireRead ?? allow,
      requireLocationAudit: opts.requireAudit ?? allow,
      now: () => NOW,
    }),
  );
  return { app, iclass };
}

describe('3.1 — el permiso operativo NO habilita vigilancia histórica', () => {
  it('allows TODAY journey with location_read (dispatch needs it)', async () => {
    const { app } = makeApp({ requireRead: allow, requireAudit: deny });
    const res = await request(app).get('/api/technicians/IPNXANDYM/journey?day=2026-07-26');
    expect(res.status).toBe(200);
  });

  it('allows YESTERDAY journey with location_read', async () => {
    const { app } = makeApp({ requireRead: allow, requireAudit: deny });
    const res = await request(app).get('/api/technicians/IPNXANDYM/journey?day=2026-07-25');
    expect(res.status).toBe(200);
  });

  it('REJECTS an older journey with only location_read', async () => {
    // El agujero original: con location_read se podía iterar 365 días por persona y
    // reconstruir horarios de entrada/salida de un año — vigilancia laboral completa.
    const { app } = makeApp({ requireRead: allow, requireAudit: deny });
    const res = await request(app).get('/api/technicians/IPNXANDYM/journey?day=2025-08-14');
    expect(res.status).toBe(403);
  });

  it('allows the historic journey WITH location_audit', async () => {
    const { app } = makeApp({ requireRead: deny, requireAudit: allow });
    const res = await request(app).get('/api/technicians/IPNXANDYM/journey?day=2025-08-14');
    expect(res.status).toBe(200);
  });

  it('rejects a FUTURE day outright', async () => {
    const { app } = makeApp({});
    const res = await request(app).get('/api/technicians/IPNXANDYM/journey?day=2027-01-01');
    expect(res.status).toBe(400);
  });
});

describe('3.3 — el rango de la auditoría está acotado', () => {
  it('rejects a range longer than 30 days', async () => {
    // Sin cota, un GET disparaba un getServiceOrderHistory EN SERIE por orden y saturaba
    // IClass, rompiendo el closure loop y la creación de OS de toda la empresa.
    const { app, iclass } = makeApp({});
    const res = await request(app).get(
      '/api/technicians/audit/suspicious-closures?from=2020-01-01&to=2099-12-31',
    );
    expect(res.status).toBe(400);
    expect(iclass.listServiceOrders).not.toHaveBeenCalled();
  });

  it('rejects an inverted range', async () => {
    const { app } = makeApp({});
    const res = await request(app).get(
      '/api/technicians/audit/suspicious-closures?from=2026-07-26&to=2026-07-01',
    );
    expect(res.status).toBe(400);
  });

  it('rejects an impossible calendar date instead of silently shifting it', async () => {
    const { app } = makeApp({});
    const res = await request(app).get(
      '/api/technicians/audit/suspicious-closures?from=2026-02-31&to=2026-03-05',
    );
    expect(res.status).toBe(400);
  });

  it('accepts a valid 30-day range', async () => {
    const { app } = makeApp({});
    const res = await request(app).get(
      '/api/technicians/audit/suspicious-closures?from=2026-07-01&to=2026-07-26',
    );
    expect(res.status).toBe(200);
  });
});

describe('3.4 — los errores no filtran internos', () => {
  it('does not leak an internal error message to the client', async () => {
    const boom = {
      listServiceOrders: jest.fn(async () => {
        throw new Error(
          'Invalid `prisma.teamLocationPoint.findMany()` invocation in /app/dist/infra/repo.js:42',
        );
      }),
      getServiceOrderHistory: jest.fn(async () => []),
    };
    const { app } = makeApp({ iclassOverride: boom });

    const res = await request(app).get('/api/technicians/audit/service-order/4995');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/app/dist');
    expect(JSON.stringify(res.body)).not.toContain('prisma.');
  });
});

describe('3.5 — el módulo technicians no es una puerta lateral al padrón de clientes', () => {
  it('does not expose customer name or street address in the audit payload', async () => {
    const { app } = makeApp({});
    const res = await request(app).get('/api/technicians/audit/service-order/4995');

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    // Para responder "¿estuvo o no estuvo?" alcanzan las coordenadas. El nombre y el
    // domicilio del cliente están detrás del módulo `clients`, no de éste.
    expect(body).not.toContain('FERNANDEZ MARIA CRISTINA');
    expect(body).not.toContain('Plaza Silvano de Jofre');
  });

  it('does not expose customer PII in the suspicious-closures list either', async () => {
    const { app } = makeApp({});
    const res = await request(app).get(
      '/api/technicians/audit/suspicious-closures?from=2026-07-01&to=2026-07-26',
    );
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('FERNANDEZ MARIA CRISTINA');
    expect(body).not.toContain('Plaza Silvano de Jofre');
  });
});

describe('3.7 — el router aplica autenticación cuando se le pasa un authProvider', () => {
  it('returns 401 without a session cookie when auth is wired', async () => {
    // Los tests de ruta inyectan guards ya resueltos y construyen el router SIN
    // authProvider, así que ninguno cubría la línea que monta el auth middleware:
    // si alguien la borraba, todo seguía verde.
    const repo = new InMemoryTeamLocationRepository();
    const iclass = {
      listServiceOrders: jest.fn(async () => [order()]),
      getServiceOrderHistory: jest.fn(async () => []),
    };
    const authProvider = {
      getSession: jest.fn(async () => {
        throw new Error('should not be reached without a cookie');
      }),
    };
    const app = express();
    app.use(express.json());
    app.use(
      '/api/technicians',
      createTechnicianLocationRouter({
        getTeamsLiveStatus: new GetTeamsLiveStatus({ repo, source, now: () => NOW }),
        getTeamDailyJourney: new GetTeamDailyJourney({ repo }),
        auditServiceOrderPresence: new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }),
        listSuspiciousClosures: new ListSuspiciousClosures({ iclass }),
        requireLocationRead: allow,
        requireLocationAudit: allow,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        authProvider: authProvider as any,
        now: () => NOW,
      }),
    );

    const res = await request(app).get('/api/technicians/live');
    expect(res.status).toBe(401);
    expect(authProvider.getSession).not.toHaveBeenCalled();
  });
});

describe('3.6 — thresholdMinutes hace lo que dice hacer', () => {
  it('forwards the threshold to the use case instead of validating and dropping it', async () => {
    const { app, iclass } = makeApp({});
    // Con umbral 90 la OS de 2m16s sigue siendo candidata; con el default 5 también.
    // Lo que se verifica es que el parámetro LLEGA: antes se validaba y se descartaba,
    // así que un auditor pedía 30 y recibía resultados de 5 sin saberlo.
    const res = await request(app).get(
      '/api/technicians/audit/suspicious-closures?from=2026-07-01&to=2026-07-26&thresholdMinutes=90',
    );
    expect(res.status).toBe(200);
    expect(res.body.meta?.thresholdMinutes).toBe(90);
    expect(iclass.listServiceOrders).toHaveBeenCalled();
  });

  it('echoes the DEFAULT threshold when none is given', async () => {
    const { app } = makeApp({});
    const res = await request(app).get(
      '/api/technicians/audit/suspicious-closures?from=2026-07-01&to=2026-07-26',
    );
    expect(res.body.meta?.thresholdMinutes).toBe(5);
  });
});
