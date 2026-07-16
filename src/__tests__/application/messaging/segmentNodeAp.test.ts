/**
 * node-segment (campañas por nodo/AP) — segmentación de Envío masivo por
 * NetworkSite (`networkSiteId`) y AccessPoint (`accessPointId`), el caso de uso
 * estrella: "aviso de corte/mantenimiento a TODOS los clientes del nodo X (o
 * del AP Y)".
 *
 * Semántica (contrato FIJO con el FE):
 *  - Un cliente entra si tiene ≥1 contrato cuyo `networkSiteId` matchea (y cuyo
 *    `accessPointId` matchea, si se pasó). Si vienen AMBOS, deben matchear en
 *    EL MISMO contrato.
 *  - Es AND con estado/deuda (statuses/balanceMin/balanceMax).
 *  - Ausente / null / '' = sin filtro.
 *  - Nodo o AP SOLOS ya cuentan como segmento válido (`assertSegmentIsFiltered`
 *    no exige statuses/deuda cuando hay nodo/AP).
 *
 * El fake de `CampaignSegmentSource` de este archivo modela EL MISMO
 * comportamiento que la query Prisma real (`buildSegmentWhere` →
 * `contracts: { some: {...} }`, pineada en
 * `PrismaCustomerRepository.list.segment.test.ts`) — convención T3.3: fake
 * inline mínimo, NO un InMemoryCustomerRepository completo.
 */
import { PreviewCampaignSegment } from '@application/use-cases/messaging/PreviewCampaignSegment';
import { ListSegmentRecipients } from '@application/use-cases/messaging/ListSegmentRecipients';
import { CreateCampaign } from '@application/use-cases/messaging/CreateCampaign';
import { SendCampaign } from '@application/use-cases/messaging/SendCampaign';
import { segmentHasCriteria, assertSegmentIsFiltered } from '@application/use-cases/messaging/assertSegmentIsFiltered';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import { ImmediateRateLimiter } from '@infrastructure/adapters/in-memory/ImmediateRateLimiter';
import { UnfilteredSegmentError } from '@domain/errors/messaging-bulk';
import type {
  CampaignSegmentSource,
  CampaignSegmentFilter,
  CampaignRecipientCandidate,
  CampaignRecipientLookup,
  ManualRecipientSource,
} from '@domain/ports/CustomerRepository';
import type { TemplateMessagingPort, TemplateDto } from '@domain/ports/TemplateMessagingPort';

/** Contrato mínimo del fake — SOLO los 2 campos de asignación de red (Fase B). */
interface FakeContract {
  networkSiteId?: string | null;
  accessPointId?: string | null;
}

interface FakeClientRow extends CampaignRecipientCandidate {
  status: string;
  /** Contratos del cliente — la base del match nodo/AP (ausente = sin contratos). */
  contracts?: FakeContract[];
}

/**
 * Mismo criterio que `contracts: { some: {...} }` de la query real: cada
 * condición pasada (nodo y/o AP) debe matchear EN ESTE contrato. '' cuenta
 * como ausente (mismo truthy-check que `buildSegmentWhere`).
 */
function contractMatchesNodeAp(contract: FakeContract, segment: CampaignSegmentFilter): boolean {
  if (segment.networkSiteId && contract.networkSiteId !== segment.networkSiteId) return false;
  if (segment.accessPointId && contract.accessPointId !== segment.accessPointId) return false;
  return true;
}

function makeSegmentSource(rows: FakeClientRow[]): CampaignSegmentSource {
  return {
    listSegmentRecipients: async (segment: CampaignSegmentFilter): Promise<CampaignRecipientCandidate[]> => {
      return rows
        .filter((r) => segment.statuses.length === 0 || segment.statuses.includes(r.status))
        .filter((r) => segment.balanceMin == null || (r.balanceDue ?? 0) >= segment.balanceMin)
        .filter((r) => segment.balanceMax == null || (r.balanceDue ?? 0) <= segment.balanceMax)
        .filter(
          (r) =>
            (!segment.networkSiteId && !segment.accessPointId) ||
            (r.contracts ?? []).some((c) => contractMatchesNodeAp(c, segment)),
        );
    },
  };
}

function makeManualSource(rows: FakeClientRow[]): ManualRecipientSource {
  return {
    findRecipientCandidatesByIds: async (ids: string[]) => {
      const wanted = new Set(ids);
      return rows.filter((r) => wanted.has(r.clientId));
    },
  };
}

function makeLookup(rows: FakeClientRow[]): CampaignRecipientLookup {
  return {
    findRecipientCandidate: async (clientId: string) => rows.find((r) => r.clientId === clientId) ?? null,
  };
}

function makeRow(overrides: Partial<FakeClientRow> = {}): FakeClientRow {
  return {
    clientId: 'c-default',
    name: 'Default',
    phone: '3364000000',
    balanceDue: 0,
    whatsappOptOutAt: null,
    status: 'active',
    ...overrides,
  };
}

const APPROVED_TEMPLATE: TemplateDto = {
  contentSid: 'HXapproved',
  friendlyName: 'aviso_corte',
  language: 'es',
  variables: {},
  approvalStatus: 'approved',
  body: 'Aviso de mantenimiento en tu zona',
};

function makeTemplatePort(templates: TemplateDto[]): TemplateMessagingPort {
  return {
    listTemplates: jest.fn().mockResolvedValue(templates),
    sendTemplate: jest.fn(),
  };
}

// ─── assertSegmentIsFiltered / segmentHasCriteria — nodo/AP SOLOS son criterio ──

describe('segmentHasCriteria — nodo/AP como criterio real', () => {
  it('networkSiteId solo (sin statuses/deuda) ES criterio — el caso "todos los del nodo X"', () => {
    expect(segmentHasCriteria({ statuses: [], networkSiteId: 'ns-1' })).toBe(true);
    expect(() => assertSegmentIsFiltered({ statuses: [], networkSiteId: 'ns-1' })).not.toThrow();
  });

  it('accessPointId solo ES criterio — el caso "todos los del AP Y"', () => {
    expect(segmentHasCriteria({ statuses: [], accessPointId: 'ap-9' })).toBe(true);
    expect(() => assertSegmentIsFiltered({ statuses: [], accessPointId: 'ap-9' })).not.toThrow();
  });

  it('null explícito NO es criterio (= ausente) → UnfilteredSegmentError', () => {
    expect(segmentHasCriteria({ statuses: [], networkSiteId: null, accessPointId: null })).toBe(false);
    expect(() => assertSegmentIsFiltered({ statuses: [], networkSiteId: null, accessPointId: null })).toThrow(
      UnfilteredSegmentError,
    );
  });

  it("'' NO es criterio (mismo truthy-check que buildSegmentWhere — evita where que no matchea nada)", () => {
    expect(segmentHasCriteria({ statuses: [], networkSiteId: '', accessPointId: '' })).toBe(false);
    expect(() => assertSegmentIsFiltered({ statuses: [], networkSiteId: '' })).toThrow(UnfilteredSegmentError);
  });
});

// ─── PreviewCampaignSegment — el composer cuenta/muestra el nodo/AP ─────────────

describe('PreviewCampaignSegment — filtro por nodo/AP', () => {
  const NODE_ROWS: FakeClientRow[] = [
    makeRow({ clientId: 'c1', phone: '3364111111', status: 'active', contracts: [{ networkSiteId: 'ns-1', accessPointId: 'ap-1' }] }),
    makeRow({ clientId: 'c2', phone: '3364222222', status: 'late', contracts: [{ networkSiteId: 'ns-1', accessPointId: 'ap-2' }] }),
    makeRow({ clientId: 'c3', phone: '3364333333', status: 'active', contracts: [{ networkSiteId: 'ns-2', accessPointId: 'ap-9' }] }),
    makeRow({ clientId: 'c4', phone: '3364444444', status: 'active', contracts: [] }), // sin contratos
  ];

  it('nodo solo (statuses vacío): entran SOLO los clientes con ≥1 contrato del nodo, sin UnfilteredSegmentError', async () => {
    const uc = new PreviewCampaignSegment(makeSegmentSource(NODE_ROWS));

    const result = await uc.execute({ statuses: [], networkSiteId: 'ns-1' });

    expect(result.count).toBe(2);
    expect(result.sample.map((s) => s.clientId)).toEqual(['c1', 'c2']);
    expect(result.statusCounts).toEqual({ active: 1, late: 1 });
  });

  it('AP solo: entran SOLO los clientes con ≥1 contrato en ese AP', async () => {
    const uc = new PreviewCampaignSegment(makeSegmentSource(NODE_ROWS));

    const result = await uc.execute({ statuses: [], accessPointId: 'ap-9' });

    expect(result.count).toBe(1);
    expect(result.sample.map((s) => s.clientId)).toEqual(['c3']);
  });

  it('nodo+AP: ambos deben matchear EN EL MISMO contrato (cruzado entre 2 contratos NO entra)', async () => {
    const rows: FakeClientRow[] = [
      // cruzado: tiene el nodo en un contrato y el AP en OTRO → NO entra
      makeRow({
        clientId: 'cx',
        phone: '3364555555',
        contracts: [{ networkSiteId: 'ns-1', accessPointId: 'ap-1' }, { networkSiteId: 'ns-2', accessPointId: 'ap-9' }],
      }),
      // mismo contrato con ambos → entra
      makeRow({ clientId: 'cy', phone: '3364666666', contracts: [{ networkSiteId: 'ns-1', accessPointId: 'ap-9' }] }),
    ];
    const uc = new PreviewCampaignSegment(makeSegmentSource(rows));

    const result = await uc.execute({ statuses: [], networkSiteId: 'ns-1', accessPointId: 'ap-9' });

    expect(result.count).toBe(1);
    expect(result.sample.map((s) => s.clientId)).toEqual(['cy']);
  });

  it('AND con statuses: nodo + late = intersección, no unión', async () => {
    const uc = new PreviewCampaignSegment(makeSegmentSource(NODE_ROWS));

    const result = await uc.execute({ statuses: ['late'], networkSiteId: 'ns-1' });

    expect(result.count).toBe(1);
    expect(result.sample.map((s) => s.clientId)).toEqual(['c2']);
  });

  it('AND con deuda: nodo + balanceMin corta a los de deuda menor', async () => {
    const rows: FakeClientRow[] = [
      makeRow({ clientId: 'c1', phone: '3364111111', balanceDue: 5000, contracts: [{ networkSiteId: 'ns-1' }] }),
      makeRow({ clientId: 'c2', phone: '3364222222', balanceDue: 50000, contracts: [{ networkSiteId: 'ns-1' }] }),
    ];
    const uc = new PreviewCampaignSegment(makeSegmentSource(rows));

    const result = await uc.execute({ statuses: [], networkSiteId: 'ns-1', balanceMin: 10000 });

    expect(result.count).toBe(1);
    expect(result.sample.map((s) => s.clientId)).toEqual(['c2']);
  });

  it('backcompat: null explícito en ambos = sin filtro nodo/AP (mismo resultado que un segmento por status)', async () => {
    const uc = new PreviewCampaignSegment(makeSegmentSource(NODE_ROWS));

    const withNulls = await uc.execute({ statuses: ['active'], networkSiteId: null, accessPointId: null });
    const without = await uc.execute({ statuses: ['active'] });

    expect(withNulls.count).toBe(3); // c1 (ns-1), c3 (ns-2), c4 (sin contratos) — nodo NO filtra
    expect(withNulls).toEqual(without);
  });

  it('unión con manuales: manual del MISMO nodo no se doble-cuenta; manual de otro nodo se suma', async () => {
    const uc = new PreviewCampaignSegment(
      makeSegmentSource(NODE_ROWS),
      makeManualSource(NODE_ROWS),
    );

    const result = await uc.execute({
      statuses: [],
      networkSiteId: 'ns-1',
      manualClientIds: ['c1', 'c3'], // c1 YA cae por el nodo; c3 es de ns-2 (solo entra por manual)
    });

    expect(result.count).toBe(3); // c1, c2 (nodo) + c3 (manual) — c1 UNA sola vez
    expect(result.sample.map((s) => s.clientId).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(result.skipped).toEqual({ optedOut: 0, duplicatePhone: 0, invalidPhone: 0 });
  });
});

// ─── ListSegmentRecipients — la tabla del PreviewModal honra el filtro ──────────

describe('ListSegmentRecipients — filtro por nodo/AP', () => {
  const ROWS: FakeClientRow[] = [
    makeRow({ clientId: 'c1', phone: '3364111111', status: 'late', contracts: [{ networkSiteId: 'ns-1', accessPointId: 'ap-1' }] }),
    makeRow({ clientId: 'c2', phone: '3364222222', status: 'active', contracts: [{ networkSiteId: 'ns-1', accessPointId: 'ap-2' }] }),
    makeRow({ clientId: 'c3', phone: '3364333333', status: 'late', contracts: [{ networkSiteId: 'ns-2', accessPointId: 'ap-9' }] }),
  ];

  it('nodo solo pagina SOLO los del nodo (data + total honran el filtro)', async () => {
    const uc = new ListSegmentRecipients(makeSegmentSource(ROWS));

    const result = await uc.execute({ statuses: [], networkSiteId: 'ns-1' });

    expect(result.total).toBe(2);
    expect(result.data.map((r) => r.clientId)).toEqual(['c1', 'c2']);
    expect(result.statusCounts).toEqual({ late: 1, active: 1 });
  });

  it('AP solo es segmento válido para la tabla (sin statuses/deuda) — no lanza UnfilteredSegmentError', async () => {
    const uc = new ListSegmentRecipients(makeSegmentSource(ROWS));

    const result = await uc.execute({ statuses: [], accessPointId: 'ap-9' });

    expect(result.total).toBe(1);
    expect(result.data.map((r) => r.clientId)).toEqual(['c3']);
  });
});

// ─── CreateCampaign — el snapshot del segmento persiste nodo/AP ─────────────────

describe('CreateCampaign — snapshot y recipients honran nodo/AP', () => {
  const ROWS: FakeClientRow[] = [
    makeRow({ clientId: 'c1', phone: '3364111111', status: 'active', contracts: [{ networkSiteId: 'ns-1', accessPointId: 'ap-1' }] }),
    makeRow({ clientId: 'c2', phone: '3364222222', status: 'late', contracts: [{ networkSiteId: 'ns-1', accessPointId: 'ap-2' }] }),
    makeRow({ clientId: 'c3', phone: '3364333333', status: 'active', contracts: [{ networkSiteId: 'ns-2', accessPointId: 'ap-9' }] }),
  ];

  it('persiste networkSiteId/accessPointId en campaign.segment (round-trip del snapshot, auditoría CAMP-1)', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const uc = new CreateCampaign(campaignRepo, makeSegmentSource(ROWS), makeTemplatePort([APPROVED_TEMPLATE]));

    const result = await uc.execute({
      name: 'Corte nodo ns-1',
      templateRef: 'HXapproved',
      segment: { statuses: [], networkSiteId: 'ns-1', accessPointId: 'ap-1' },
      variablesMap: {},
      createdById: 'user-1',
    });

    const persisted = await campaignRepo.findById(result.campaignId);
    expect(persisted?.segment.networkSiteId).toBe('ns-1');
    expect(persisted?.segment.accessPointId).toBe('ap-1');
    expect(persisted?.segment.statuses).toEqual([]);
  });

  it('los recipients materializados son SOLO los del nodo (el filtro no es cosmético del preview)', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const uc = new CreateCampaign(campaignRepo, makeSegmentSource(ROWS), makeTemplatePort([APPROVED_TEMPLATE]));

    const result = await uc.execute({
      name: 'Mantenimiento ns-1',
      templateRef: 'HXapproved',
      segment: { statuses: [], networkSiteId: 'ns-1' },
      variablesMap: {},
      createdById: 'user-1',
    });

    expect(result.total).toBe(2);
    const recipients = await campaignRepo.listRecipients(result.campaignId);
    expect(recipients.data.map((r) => r.clientId).sort()).toEqual(['c1', 'c2']);
  });
});

// ─── SendCampaign — el ENVÍO REAL honra el filtro (pipeline create→send) ────────

describe('SendCampaign — el envío honra el filtro nodo/AP vía el snapshot de recipients', () => {
  it('create con networkSiteId → send: sendTemplate SOLO a los clientes del nodo, jamás a los de otro nodo', async () => {
    const rows: FakeClientRow[] = [
      makeRow({ clientId: 'c1', phone: '3364111111', status: 'active', contracts: [{ networkSiteId: 'ns-1' }] }),
      makeRow({ clientId: 'c2', phone: '3364222222', status: 'active', contracts: [{ networkSiteId: 'ns-1' }] }),
      makeRow({ clientId: 'c3', phone: '3364999999', status: 'active', contracts: [{ networkSiteId: 'ns-2' }] }),
    ];
    const campaignRepo = new InMemoryCampaignRepository();
    const gateway = new InMemoryTemplateMessagingGateway({ templates: [APPROVED_TEMPLATE] });
    const createUc = new CreateCampaign(campaignRepo, makeSegmentSource(rows), gateway);

    const created = await createUc.execute({
      name: 'Corte programado ns-1',
      templateRef: 'HXapproved',
      segment: { statuses: [], networkSiteId: 'ns-1' },
      variablesMap: {},
      createdById: 'user-1',
    });

    const sendUc = new SendCampaign(campaignRepo, makeLookup(rows), gateway, new ImmediateRateLimiter());
    const finished = await sendUc.execute({ campaignId: created.campaignId });

    // los DOS del nodo se enviaron; el de ns-2 JAMÁS recibió un send
    expect(finished.sentCount).toBe(2);
    const recipients = await campaignRepo.listRecipients(created.campaignId);
    const expectedTargets = recipients.data.map((r) => r.phoneE164).sort();
    expect(gateway.calls.map((c) => c.to).sort()).toEqual(expectedTargets);
    expect(recipients.data.map((r) => r.clientId).sort()).toEqual(['c1', 'c2']);
    expect(gateway.calls.some((c) => c.to.includes('3364999999'))).toBe(false);
  });
});
