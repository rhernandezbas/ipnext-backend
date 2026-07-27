import { AuditServiceOrderPresence } from '@application/use-cases/AuditServiceOrderPresence';
import { InMemoryTeamLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryTeamLocationRepository';
import type { ClosedServiceOrderSummary, SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';
import type { TeamLocationPoint } from '@domain/entities/team-location-point';

const NOW = new Date('2026-07-26T12:00:00Z');

function so(over: Partial<ClosedServiceOrderSummary> = {}): ClosedServiceOrderSummary {
  return {
    iclassId: '101040569399',
    iclassCodigo: '4995',
    clusterName: 'IPNEXT INTERNET',
    thirdPartyCode: 'IPNX',
    nodeCode: 'General Rodriguez',
    soTypeId: '1',
    soTypeDescription: 'RETIROS DE EQUIPOS',
    customerCode: 'C1',
    customerName: 'FERNANDEZ MARIA CRISTINA',
    addressCode: 'A1',
    addressLine: 'Plaza Silvano de Jofre',
    addressCity: 'Tomas Jofre',
    addressLat: -34.70084,
    addressLng: -59.32028,
    statusCode: '7',
    statusDescription: 'Concluida',
    requestedAt: null,
    scheduledFor: '2026-07-01T03:00:00.000Z',
    availableAt: null,
    serviceStartedAt: null,
    serviceEndedAt: null,
    resultCodeName: 'Cliente Ausente.',
    closedByLogin: 'IPNXLUISS',
    closedByName: 'luis Sarcos',
    closeLatitude: null,
    closeLongitude: null,
    closeGpsAt: null,
    billingAmount: 0,
    technicianNote: null,
    internalNote: null,
    commentaryLog: null,
    teamLogin: 'IPNXANDYM',
    teamTechnicianName: 'Andy Medina',
    teamPhone: null,
    teamEmail: null,
    iclassCreatedAt: null,
    iclassUpdatedAt: null,
    rawDetail: {},
    ...over,
  };
}

const ev = (iso: string, statusDescription: string, teamLogin: string | null = 'IPNXANDYM'): SoStatusHistoryEntry => ({
  iclassOsStatusId: 'x',
  occurredAt: iso,
  statusCode: '0',
  statusDescription,
  durationMinutes: null,
  teamLogin,
  commentary: null,
});

/** Histórico REAL de la OS 4995 (ejecución), ya en UTC. */
const HISTORY_4995 = [
  ev('2026-06-22T14:20:32.000Z', 'AGENDADA', null),
  ev('2026-07-01T23:29:02.000Z', 'DESLOCAMENTO'),
  ev('2026-07-01T23:29:13.000Z', 'ANDAMENTO'),
  ev('2026-07-01T23:31:18.000Z', 'FECHADA'),
  ev('2026-07-02T13:40:25.000Z', 'ENCERRADO'),
];

const point = (iso: string, lat: number, lon: number, accuracyMeters = 10, teamLogin = 'IPNXANDYM'): TeamLocationPoint => ({
  teamLogin,
  latitude: lat,
  longitude: lon,
  recordedAt: new Date(iso),
  accuracyMeters,
  sources: [1],
});

function makeIClass(summary: ClosedServiceOrderSummary | null, history: SoStatusHistoryEntry[]) {
  return {
    listServiceOrders: jest.fn(async () => (summary ? [summary] : [])),
    getServiceOrderHistory: jest.fn(async () => history),
  };
}

describe('AuditServiceOrderPresence', () => {
  it('reproduces the verified OS 4995 case: FUERA_DE_SITIO at ~12.8 km', async () => {
    const repo = new InMemoryTeamLocationRepository();
    await repo.saveMany([
      point('2026-07-01T23:23:37Z', -34.6152, -59.4234, 45.5),
      point('2026-07-01T23:33:39Z', -34.6152, -59.4234, 31.8),
      point('2026-07-01T23:43:39Z', -34.6152, -59.4234, 67.5),
    ]);

    const iclass = makeIClass(so(), HISTORY_4995);
    const res = await new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }).execute({
      serviceOrderCode: '4995',
    });

    expect(res.verdict).toBe('FUERA_DE_SITIO');
    expect(res.minDistanceMeters).toBeGreaterThan(10_000);
    expect(res.pointsEvaluated).toBe(3);
    expect(res.serviceOrderCode).toBe('4995');
    expect(res.teamLogin).toBe('IPNXANDYM');
    expect(res.mapsUrl).toContain('google.com/maps');
  });

  it('uses the EXECUTION window, not the scheduled date', async () => {
    const repo = new InMemoryTeamLocationRepository();
    // Punto en el domicilio pero en el día AGENDADO (22-06), no en el de ejecución.
    await repo.saveMany([point('2026-06-22T14:30:00Z', -34.70084, -59.32028)]);

    const iclass = makeIClass(so(), HISTORY_4995);
    const res = await new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }).execute({
      serviceOrderCode: '4995',
    });

    // Ese punto NO cuenta: cae fuera de la ventana de ejecución.
    expect(res.pointsEvaluated).toBe(0);
    expect(res.verdict).toBe('NO_CONCLUYENTE');
  });

  it('is NO_CONCLUYENTE when the team was not reporting during the window', async () => {
    const repo = new InMemoryTeamLocationRepository();
    const iclass = makeIClass(so(), HISTORY_4995);

    const res = await new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }).execute({
      serviceOrderCode: '4995',
    });

    expect(res.verdict).toBe('NO_CONCLUYENTE');
    // Hallazgo 1.12: el motivo describe lo que el sistema SABE (no hay registros en la
    // base), sin afirmar POR QUÉ faltan — hay 4 causas indistinguibles.
    expect(res.reason).toMatch(/no hay registros/i);
    expect(res.reason).not.toMatch(/pudo no estar reportando/i);
  });

  it('is NO_AUDITABLE when the order has no geolocated address', async () => {
    const repo = new InMemoryTeamLocationRepository();
    const iclass = makeIClass(so({ addressLat: null, addressLng: null }), HISTORY_4995);

    const res = await new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }).execute({
      serviceOrderCode: '4995',
    });
    expect(res.verdict).toBe('NO_AUDITABLE');
    expect(res.reason).toMatch(/domicilio/i);
  });

  it('is NO_AUDITABLE when NEITHER the order NOR the history names a team', async () => {
    // Hallazgo 1.3: la cuadrilla auditada sale del CICLO del histórico (que es la que
    // realmente ejecutó), con fallback a la asignada hoy. Para que no haya ninguna,
    // ambas fuentes tienen que estar vacías.
    const repo = new InMemoryTeamLocationRepository();
    const historyWithoutTeam = HISTORY_4995.map((e) => ({ ...e, teamLogin: null }));
    const iclass = makeIClass(so({ teamLogin: null }), historyWithoutTeam);

    const res = await new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }).execute({
      serviceOrderCode: '4995',
    });
    expect(res.verdict).toBe('NO_AUDITABLE');
    expect(res.reason).toMatch(/cuadrilla/i);
  });

  it('is NO_AUDITABLE when the order was never executed', async () => {
    const repo = new InMemoryTeamLocationRepository();
    const iclass = makeIClass(so(), [ev('2026-07-01T13:00:00.000Z', 'AGENDADA', null)]);

    const res = await new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }).execute({
      serviceOrderCode: '4995',
    });
    expect(res.verdict).toBe('NO_AUDITABLE');
    expect(res.reason).toMatch(/ventana/i);
  });

  it('returns NO_AUDITABLE when the order does not exist in IClass', async () => {
    const repo = new InMemoryTeamLocationRepository();
    const iclass = makeIClass(null, []);

    const res = await new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }).execute({
      serviceOrderCode: '9999',
    });
    expect(res.verdict).toBe('NO_AUDITABLE');
    expect(res.reason).toMatch(/no se encontr/i);
  });

  it('reports EN_SITIO reproducing OS 4905 (3 m) — the single-point false negative', async () => {
    const repo = new InMemoryTeamLocationRepository();
    await repo.saveMany([point('2026-07-01T23:30:00Z', -34.700845, -59.320285, 10.5)]);

    const iclass = makeIClass(so({ iclassCodigo: '4905' }), HISTORY_4995);
    const res = await new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }).execute({
      serviceOrderCode: '4905',
    });

    expect(res.verdict).toBe('EN_SITIO');
    expect(res.minDistanceMeters).toBeLessThan(10);
  });

  it('R2/1.3 — audits the team from the HISTORY, not the one assigned today', async () => {
    // Se revirtió el fix y 4.447 tests siguieron verdes: todos los fixtures tenían
    // order.teamLogin === history.teamLogin. Este test es la red que faltaba.
    const repo = new InMemoryTeamLocationRepository();
    // Puntos EN el domicilio, pero de la cuadrilla que EJECUTÓ (LUISS), no de la asignada.
    await repo.saveMany([
      point('2026-07-01T23:20:00Z', -34.70084, -59.32028, 9, 'IPNXLUISS'),
      point('2026-07-01T23:30:00Z', -34.70084, -59.32028, 9, 'IPNXLUISS'),
      point('2026-07-01T23:40:00Z', -34.70084, -59.32028, 9, 'IPNXLUISS'),
    ]);

    const executedByLuis = HISTORY_4995.map((e) => ({ ...e, teamLogin: 'IPNXLUISS' }));
    const iclass = makeIClass(so({ teamLogin: 'IPNXANDYM' }), executedByLuis);

    const res = await new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }).execute({
      serviceOrderCode: '4995',
    });

    // Con order.teamLogin se pediría el rastro de ANDYM (vacío) → NO_CONCLUYENTE.
    expect(res.teamLogin).toBe('IPNXLUISS');
    expect(res.verdict).toBe('EN_SITIO');
  });

  it('R2/1.6 — requires an EXACT service-order code match (IClass filters like a prefix)', async () => {
    const repo = new InMemoryTeamLocationRepository();
    // IClass devuelve la 4995 cuando se pide la 499 (comportamiento tipo LIKE/prefijo).
    const iclass = {
      listServiceOrders: jest.fn(async () => [so({ iclassCodigo: '4995' })]),
      getServiceOrderHistory: jest.fn(async () => HISTORY_4995),
    };

    const res = await new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }).execute({
      serviceOrderCode: '499',
    });

    // Sin el guard se auditaría OTRO domicilio, otra cuadrilla y otra ventana, reportado
    // bajo el código pedido — y el reporte ni siquiera delataría el desvío.
    expect(res.verdict).toBe('NO_AUDITABLE');
    expect(res.reason).toMatch(/no se encontr/i);
    expect(iclass.getServiceOrderHistory).not.toHaveBeenCalled();
  });

  it('exposes the closure-coordinates gap explicitly (IClass leaves them empty)', async () => {
    const repo = new InMemoryTeamLocationRepository();
    const iclass = makeIClass(so(), HISTORY_4995);

    const res = await new AuditServiceOrderPresence({ iclass, repo, now: () => NOW }).execute({
      serviceOrderCode: '4995',
    });
    // Medido: 0 de 416 OS de julio traen coordenadasFechamento. Se reporta como ausente,
    // no se inventa ni se deriva de otra cosa.
    expect(res.closureCoordinates).toBeNull();
  });
});
