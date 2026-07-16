/**
 * messaging-bulk (F2, Batch 6, T6.1/T6.3) — pure `where`-builder tests for the
 * segmentation extension of `PrismaCustomerRepository`. NO Prisma/DB involved
 * (regla CLAUDE.md: no hay DB local, no se mockea Prisma) — `buildClientListWhere`
 * and `buildSegmentWhere` are extracted as pure functions precisely so the
 * precedence/filter logic is testable without touching the ORM (same pattern
 * as `PrismaCustomerRepository.mappers.test.ts`, which tests `toCustomer` et al.
 * in isolation).
 */
import { buildClientListWhere, buildSegmentWhere, toCampaignRecipientCandidate } from '../../infrastructure/adapters/prisma/PrismaCustomerRepository';
import { resolveRecipients } from '../../application/use-cases/messaging/resolveRecipients';
import type { ListClientsQuery } from '../../domain/ports/CustomerRepository';
import type { CampaignSegmentFilter, CampaignRecipientCandidate } from '../../domain/ports/CustomerRepository';

describe('buildClientListWhere (T6.1 — SEG-1, aditivo sobre ListClients F1)', () => {
  it('sin statuses/balance — solo status single (path F1 intacto)', () => {
    const query: ListClientsQuery = { status: 'active' };
    expect(buildClientListWhere(query)).toEqual({ status: 'active' });
  });

  it('sin ningún filtro — where vacío (F1 default)', () => {
    expect(buildClientListWhere({})).toEqual({});
  });

  it('statuses (multi) tiene PRECEDENCIA sobre status single cuando ambos vienen', () => {
    const query: ListClientsQuery = { status: 'active', statuses: ['late', 'blocked'] };
    expect(buildClientListWhere(query)).toEqual({ status: { in: ['late', 'blocked'] } });
  });

  it('statuses vacío ([]) NO gana — cae al path status single', () => {
    const query: ListClientsQuery = { status: 'active', statuses: [] };
    expect(buildClientListWhere(query)).toEqual({ status: 'active' });
  });

  it('balanceMin/balanceMax combinados con statuses (AND, no OR)', () => {
    const query: ListClientsQuery = { statuses: ['late'], balanceMin: 10000, balanceMax: 50000 };
    expect(buildClientListWhere(query)).toEqual({
      status: { in: ['late'] },
      balanceDue: { gte: 10000, lte: 50000 },
    });
  });

  it('solo balanceMin (sin balanceMax, sin status/statuses) — rango abierto por arriba', () => {
    const query: ListClientsQuery = { balanceMin: 1000 };
    expect(buildClientListWhere(query)).toEqual({ balanceDue: { gte: 1000 } });
  });

  it('preserva el filtro `search` existente (OR name/email/login/phone) sin romperlo', () => {
    const query: ListClientsQuery = { search: 'garcia' };
    expect(buildClientListWhere(query)).toEqual({
      OR: [
        { name: { contains: 'garcia', mode: 'insensitive' } },
        { email: { contains: 'garcia', mode: 'insensitive' } },
        { login: { contains: 'garcia', mode: 'insensitive' } },
        { phone: { contains: 'garcia', mode: 'insensitive' } },
      ],
    });
  });

  // ── manual-recipients (MAN-6): el search matchea también por teléfono ────────
  // Para armar la lista manual del composer hay que poder encontrar por fragmento
  // de teléfono, no solo por nombre/email/login.
  it('MAN-6: search por fragmento de teléfono incluye `phone` en el OR', () => {
    const query: ListClientsQuery = { search: '3364' };
    const where = buildClientListWhere(query);
    expect(where['OR']).toContainEqual({ phone: { contains: '3364', mode: 'insensitive' } });
  });
});

describe('buildSegmentWhere (T6.3 — SEG-1 + fix wave 2: FIX-11 opt-out / FIX-12 NULL balance)', () => {
  // FIX-11 — el where NO pre-filtra opt-out a nivel query; `resolveRecipients`
  // (SEG-2) los excluye Y los CUENTA (así `skipped.optedOut` es real en prod; el
  // SEND path re-chequea opt-out en SEND-5, no hay hueco de compliance).
  it('FIX-11: statuses no vacío — NO agrega whatsappOptOutAt al where (deja que resolveRecipients lo cuente)', () => {
    const segment: CampaignSegmentFilter = { statuses: ['late', 'blocked'] };
    const where = buildSegmentWhere(segment);
    expect(where).toEqual({ status: { in: ['late', 'blocked'] } });
    expect(where).not.toHaveProperty('whatsappOptOutAt');
  });

  it('statuses vacío ([]) — escape hatch OPT-2: where vacío (universo completo, incl. opt-out)', () => {
    const segment: CampaignSegmentFilter = { statuses: [] };
    expect(buildSegmentWhere(segment)).toEqual({});
  });

  it('statuses vacío + balanceMin>0/balanceMax — rango sin status (SEG-1 "rango sin status"), excluye NULL', () => {
    const segment: CampaignSegmentFilter = { statuses: [], balanceMin: 1000, balanceMax: 100000 };
    expect(buildSegmentWhere(segment)).toEqual({ balanceDue: { gte: 1000, lte: 100000 } });
  });

  it('FIX-11: statuses no vacío + balanceMin>0 combinado (AND), sin whatsappOptOutAt', () => {
    const segment: CampaignSegmentFilter = { statuses: ['late'], balanceMin: 10000 };
    expect(buildSegmentWhere(segment)).toEqual({
      status: { in: ['late'] },
      balanceDue: { gte: 10000 },
    });
  });

  // FIX-12 — `balanceDue:{gte,lte}` EXCLUYE en silencio las filas balanceDue=NULL
  // (deudores never-synced). Semántica: sin piso (o piso 0) se INCLUYEN vía OR;
  // con piso >0 se excluyen (no se puede confirmar que su monto ≥ piso).
  it('FIX-12: {statuses:[late], balanceMin:0} INCLUYE los balanceDue=NULL (OR con balanceDue:null)', () => {
    const segment: CampaignSegmentFilter = { statuses: ['late'], balanceMin: 0 };
    expect(buildSegmentWhere(segment)).toEqual({
      status: { in: ['late'] },
      OR: [{ balanceDue: { gte: 0 } }, { balanceDue: null }],
    });
  });

  it('FIX-12: {balanceMin:1000} EXCLUYE los balanceDue=NULL (rango cerrado, sin OR null)', () => {
    const segment: CampaignSegmentFilter = { statuses: [], balanceMin: 1000 };
    const where = buildSegmentWhere(segment);
    expect(where).toEqual({ balanceDue: { gte: 1000 } });
    expect(where).not.toHaveProperty('OR');
  });

  it('FIX-12: solo balanceMax (sin piso) INCLUYE los NULL (never-synced) vía OR', () => {
    const segment: CampaignSegmentFilter = { statuses: ['late'], balanceMax: 5000 };
    expect(buildSegmentWhere(segment)).toEqual({
      status: { in: ['late'] },
      OR: [{ balanceDue: { lte: 5000 } }, { balanceDue: null }],
    });
  });

  // ── node-segment: filtro por nodo/AP vía relación a contratos ────────────────
  // UNA query con relation filter (`contracts: { some: {...} }`) — el join lo
  // resuelve Postgres, sin N+1 ni fetch de contratos en memoria.
  //
  // H1 (fix wave) — el `some` EXCLUYE contratos de baja en el MISMO some
  // (`NOT status='baja'`, case-insensitive — molde PrismaContractPairingReader):
  // `Contract.networkSiteId` no se limpia nunca, así que un contrato VIEJO de
  // baja en el nodo X matchearía y el cliente mudado/dado de baja recibiría el
  // "aviso de corte del nodo X" de un nodo que ya no lo sirve.
  const NOT_BAJA = { NOT: { status: { equals: 'baja', mode: 'insensitive' } } };

  it('node-segment: networkSiteId solo → contracts.some.networkSiteId (≥1 contrato NO-baja del nodo)', () => {
    const segment: CampaignSegmentFilter = { statuses: [], networkSiteId: 'ns-1' };
    expect(buildSegmentWhere(segment)).toEqual({
      contracts: { some: { networkSiteId: 'ns-1', ...NOT_BAJA } },
    });
  });

  it('node-segment: accessPointId solo → contracts.some.accessPointId (AP sin nodo es válido)', () => {
    const segment: CampaignSegmentFilter = { statuses: [], accessPointId: 'ap-9' };
    expect(buildSegmentWhere(segment)).toEqual({
      contracts: { some: { accessPointId: 'ap-9', ...NOT_BAJA } },
    });
  });

  it('node-segment: nodo+AP en UN SOLO some → ambos deben matchear en EL MISMO contrato (no-baja)', () => {
    const segment: CampaignSegmentFilter = { statuses: [], networkSiteId: 'ns-1', accessPointId: 'ap-9' };
    expect(buildSegmentWhere(segment)).toEqual({
      contracts: { some: { networkSiteId: 'ns-1', accessPointId: 'ap-9', ...NOT_BAJA } },
    });
  });

  it('node-segment: AND con statuses + balanceMin>0 (keys top-level, Prisma los ANDea)', () => {
    const segment: CampaignSegmentFilter = { statuses: ['late'], balanceMin: 1000, networkSiteId: 'ns-1' };
    expect(buildSegmentWhere(segment)).toEqual({
      status: { in: ['late'] },
      balanceDue: { gte: 1000 },
      contracts: { some: { networkSiteId: 'ns-1', ...NOT_BAJA } },
    });
  });

  // H1 pin — la exclusión de baja vive DENTRO del some (mismo contrato), no como
  // condición top-level: un cliente con contrato baja en el nodo X + contrato
  // activo en el nodo Y debe entrar por Y (su some matchea) y NO por X (el único
  // contrato de X es baja → el some no matchea ningún contrato). El shape con
  // NOT-en-el-some es exactamente lo que garantiza ambas cosas a la vez.
  it('H1: la exclusión de baja está DENTRO del some — nodo/AP y no-baja sobre el MISMO contrato', () => {
    const where = buildSegmentWhere({ statuses: [], networkSiteId: 'ns-x' });
    const some = (where['contracts'] as { some: Record<string, unknown> }).some;
    expect(some['networkSiteId']).toBe('ns-x');
    expect(some['NOT']).toEqual({ status: { equals: 'baja', mode: 'insensitive' } });
    expect(where).not.toHaveProperty('NOT'); // NO es una condición top-level sobre Client
  });

  // L2 pin — combo FIX-12 (OR de balance-null) + nodo: conviven como AND
  // top-level sin colisión de keys (el OR es del balance, contracts es del nodo).
  it('L2: balanceMax sin piso (OR balance-null) + networkSiteId → ambas keys top-level, AND', () => {
    const segment: CampaignSegmentFilter = { statuses: [], balanceMax: 5000, networkSiteId: 'ns-x' };
    expect(buildSegmentWhere(segment)).toEqual({
      OR: [{ balanceDue: { lte: 5000 } }, { balanceDue: null }],
      contracts: { some: { networkSiteId: 'ns-x', ...NOT_BAJA } },
    });
  });

  it('node-segment: null/undefined/"" NO agregan la key contracts (sin filtro nodo/AP)', () => {
    expect(buildSegmentWhere({ statuses: ['late'], networkSiteId: null, accessPointId: null })).toEqual({
      status: { in: ['late'] },
    });
    expect(buildSegmentWhere({ statuses: ['late'] })).toEqual({ status: { in: ['late'] } });
    // '' — mismo criterio que segmentHasCriteria: string vacío = ausente (un
    // some con '' no matchearía NINGÚN contrato y silenciaría la campaña).
    expect(buildSegmentWhere({ statuses: ['late'], networkSiteId: '', accessPointId: '' })).toEqual({
      status: { in: ['late'] },
    });
  });
});

// ── FIX-11 (raíz del review): el where + resolveRecipients JUNTOS reportan bien ──
describe('FIX-11 raíz — buildSegmentWhere + resolveRecipients: skipped.optedOut REAL (no 0)', () => {
  it('el where NO pre-filtra opt-out → los opt-out llegan a resolveRecipients y se CUENTAN', () => {
    const segment: CampaignSegmentFilter = { statuses: ['late'] };
    // (1) el where construido NO excluye opt-out — ESA es la raíz del review.
    expect(buildSegmentWhere(segment)).not.toHaveProperty('whatsappOptOutAt');

    // (2) por eso la query ahora devuelve TAMBIÉN los opt-out; resolveRecipients
    //     (SEG-2) los excluye del envío pero los CUENTA. Antes daba 0 en prod (el
    //     query los filtraba antes) y el fake infiel lo enmascaraba.
    const rowsFromQuery: CampaignRecipientCandidate[] = [
      { clientId: 'c1', name: 'A', phone: '3364111111', balanceDue: 1000, whatsappOptOutAt: '2026-01-01T00:00:00.000Z' },
      { clientId: 'c2', name: 'B', phone: '3364222222', balanceDue: 2000, whatsappOptOutAt: '2026-02-01T00:00:00.000Z' },
      { clientId: 'c3', name: 'C', phone: '3364333333', balanceDue: 3000, whatsappOptOutAt: null },
    ];
    const { resolved, excludedOptOut } = resolveRecipients(rowsFromQuery);
    expect(excludedOptOut).toBe(2); // REAL, no 0
    expect(resolved.map((r) => r.clientId)).toEqual(['c3']);
  });
});

describe('toCampaignRecipientCandidate (T6.3 — mapper narrow de Prisma row a CampaignRecipientCandidate)', () => {
  it('mapea una fila completa', () => {
    const row = {
      id: 'c-1',
      name: 'Juan Perez',
      phone: '3364123456',
      balanceDue: 5000,
      whatsappOptOutAt: null,
    };
    expect(toCampaignRecipientCandidate(row)).toEqual({
      clientId: 'c-1',
      name: 'Juan Perez',
      phone: '3364123456',
      balanceDue: 5000,
      whatsappOptOutAt: null,
    });
  });

  it('mapea whatsappOptOutAt Date a ISO string', () => {
    const row = {
      id: 'c-2',
      name: 'Ana',
      phone: '3364000000',
      balanceDue: null,
      whatsappOptOutAt: new Date('2026-07-01T12:00:00.000Z'),
    };
    const candidate = toCampaignRecipientCandidate(row);
    expect(candidate.whatsappOptOutAt).toBe('2026-07-01T12:00:00.000Z');
    expect(candidate.balanceDue).toBeNull();
  });

  it('mapea balanceDue tipo Decimal (con .toNumber())', () => {
    const row = {
      id: 'c-3',
      name: 'Decimal Client',
      phone: null,
      balanceDue: { toNumber: () => 12345.5 },
      whatsappOptOutAt: null,
    };
    const candidate = toCampaignRecipientCandidate(row);
    expect(candidate.balanceDue).toBe(12345.5);
    expect(candidate.phone).toBeNull();
  });

  // ── messaging-bulk v1.1 (preview modal, statusCounts) — mapea `status` ────────
  it('v1.1: mapea `status` de la fila TAL CUAL (para statusCounts/sample en el preview)', () => {
    const row = {
      id: 'c-4',
      name: 'Juana Late',
      phone: '3364000000',
      balanceDue: 5000,
      whatsappOptOutAt: null,
      status: 'late',
    };
    const candidate = toCampaignRecipientCandidate(row);
    expect(candidate.status).toBe('late');
  });
});
