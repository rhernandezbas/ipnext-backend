import { ListSuspiciousClosures } from '@application/use-cases/ListSuspiciousClosures';
import type { ClosedServiceOrderSummary, SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';

const ev = (
  iso: string,
  statusDescription: string,
  teamLogin: string | null = 'IPNXANDYM',
): SoStatusHistoryEntry => ({
  iclassOsStatusId: 'x',
  occurredAt: iso,
  statusCode: '0',
  statusDescription,
  durationMinutes: null,
  teamLogin,
  commentary: null,
});

function so(iclassId: string, codigo: string, over: Partial<ClosedServiceOrderSummary> = {}): ClosedServiceOrderSummary {
  return {
    iclassId,
    iclassCodigo: codigo,
    clusterName: 'IPNEXT INTERNET',
    thirdPartyCode: null, nodeCode: null, soTypeId: null, soTypeDescription: 'RETIROS DE EQUIPOS',
    customerCode: null, customerName: 'Cliente X', addressCode: null, addressLine: 'Calle 1',
    addressCity: null, addressLat: -34.7, addressLng: -59.3,
    statusCode: '7', statusDescription: 'Concluida',
    requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: 'Cliente Ausente.', closedByLogin: 'IPNXLUISS', closedByName: 'luis Sarcos',
    closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: 0,
    technicianNote: null, internalNote: null, commentaryLog: null,
    teamLogin: 'IPNXANDYM', teamTechnicianName: 'Andy Medina', teamPhone: null, teamEmail: null,
    iclassCreatedAt: null, iclassUpdatedAt: null, rawDetail: {},
    ...over,
  };
}

/** OS 4995 real: DESLOCAMENTO 23:29:02 → FECHADA 23:31:18 == 2m16s. */
const IMPOSSIBLE = [
  ev('2026-07-01T23:29:02.000Z', 'DESLOCAMENTO'),
  ev('2026-07-01T23:29:13.000Z', 'ANDAMENTO'),
  ev('2026-07-01T23:31:18.000Z', 'FECHADA'),
];

const PLAUSIBLE = [
  ev('2026-07-01T15:00:00.000Z', 'DESLOCAMENTO'),
  ev('2026-07-01T15:25:00.000Z', 'ANDAMENTO'),
  ev('2026-07-01T16:10:00.000Z', 'FECHADA'),
];

const NEVER_EXECUTED = [ev('2026-07-01T13:00:00.000Z', 'AGENDADA')];

function makeIClass(orders: ClosedServiceOrderSummary[], histories: Record<string, SoStatusHistoryEntry[]>) {
  return {
    listServiceOrders: jest.fn(async () => orders),
    getServiceOrderHistory: jest.fn(async (id: string) => histories[id] ?? []),
  };
}

const RANGE = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-26T00:00:00Z') };

describe('ListSuspiciousClosures', () => {
  it('flags a closure shorter than the threshold — no GPS involved', async () => {
    const iclass = makeIClass([so('1', '4995')], { '1': IMPOSSIBLE });

    const res = (await new ListSuspiciousClosures({ iclass }).execute(RANGE)).candidates;

    expect(res).toHaveLength(1);
    expect(res[0].serviceOrderCode).toBe('4995');
    expect(res[0].executionMinutes).toBeCloseTo(2.27, 1);
    expect(res[0].resultCodeName).toBe('Cliente Ausente.');
    expect(res[0].teamLogin).toBe('IPNXANDYM');
  });

  it('R3 — reports the team that EXECUTED the cycle, not the one assigned today', async () => {
    // La versión anterior de este archivo consagraba el comportamiento equivocado:
    // assertaba `IPNXANDYM` (la asignada) con el histórico entero de otra cuadrilla.
    const iclass = makeIClass([so('1', '4995')], {
      '1': [
        ev('2026-07-01T23:29:02.000Z', 'DESLOCAMENTO', 'IPNXLUISS'),
        ev('2026-07-01T23:31:18.000Z', 'FECHADA', 'IPNXLUISS'),
      ],
    });
    const res = (await new ListSuspiciousClosures({ iclass }).execute(RANGE)).candidates;
    expect(res[0].teamLogin).toBe('IPNXLUISS');
    // El nombre del técnico de la orden NO corresponde a esa cuadrilla: no se inventa.
    expect(res[0].teamTechnicianName).toBeNull();
  });

  it('R4 — an unreadable timestamp never produces a NaN candidate with a name attached', async () => {
    const iclass = makeIClass([so('1', '4995')], {
      '1': [
        { ...ev('2026-07-01T15:00:00.000Z', 'DESLOCAMENTO'), occurredAt: 'no-es-una-fecha' },
        ev('2026-07-01T19:00:00.000Z', 'FECHADA'),
      ],
    });
    const res = (await new ListSuspiciousClosures({ iclass }).execute(RANGE)).candidates;
    // `NaN >= threshold` es false, así que sin el guard el candidato pasaba el filtro.
    expect(res).toEqual([]);
  });

  it('does NOT flag a plausible visit', async () => {
    const iclass = makeIClass([so('2', '4862')], { '2': PLAUSIBLE });
    const res = (await new ListSuspiciousClosures({ iclass }).execute(RANGE)).candidates;
    expect(res).toEqual([]);
  });

  it('ignores orders that were never executed (no window to measure)', async () => {
    const iclass = makeIClass([so('3', '5000')], { '3': NEVER_EXECUTED });
    const res = (await new ListSuspiciousClosures({ iclass }).execute(RANGE)).candidates;
    expect(res).toEqual([]);
  });

  it('honours a custom threshold', async () => {
    const iclass = makeIClass([so('2', '4862')], { '2': PLAUSIBLE });
    // 70 minutos: con umbral de 90 pasa a ser candidata.
    const res = (await new ListSuspiciousClosures({ iclass, thresholdMinutes: 90 }).execute(RANGE)).candidates;
    expect(res).toHaveLength(1);
  });

  it('sorts the shortest (most suspicious) first', async () => {
    const iclass = makeIClass([so('1', '4995'), so('4', '4996')], {
      '1': IMPOSSIBLE,
      '4': [ev('2026-07-01T10:00:00.000Z', 'DESLOCAMENTO'), ev('2026-07-01T10:04:00.000Z', 'FECHADA')],
    });
    const res = (await new ListSuspiciousClosures({ iclass }).execute(RANGE)).candidates;
    expect(res.map((r) => r.serviceOrderCode)).toEqual(['4995', '4996']);
  });

  it('never labels a candidate as an infraction', async () => {
    const iclass = makeIClass([so('1', '4995')], { '1': IMPOSSIBLE });
    const res = (await new ListSuspiciousClosures({ iclass }).execute(RANGE)).candidates;
    // El contrato marca CANDIDATOS a revisar. No hay campo de veredicto ni de culpa.
    expect(res[0]).not.toHaveProperty('verdict');
    expect(res[0].isCandidateForReview).toBe(true);
  });

  it('does not let one failing history abort the whole scan', async () => {
    const iclass = {
      listServiceOrders: jest.fn(async () => [so('1', '4995'), so('9', 'BOOM')]),
      getServiceOrderHistory: jest.fn(async (id: string) => {
        if (id === '9') throw new Error('boom');
        return IMPOSSIBLE;
      }),
    };
    const res = (await new ListSuspiciousClosures({ iclass }).execute(RANGE)).candidates;
    expect(res.map((r) => r.serviceOrderCode)).toEqual(['4995']);
  });
});
