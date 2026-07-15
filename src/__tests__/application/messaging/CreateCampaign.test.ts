/**
 * messaging-bulk (F2, T3.7) — CreateCampaign. CAMP-1..CAMP-4 completos.
 * Constructor `(campaignRepo, segmentSource, templatePort)` — 3 args, NO 2
 * (tasks.md contradicción #2: design §7 wiring original olvidaba el
 * templatePort; CAMP-2 lo necesita para validar `templateRef` aprobado).
 * `variablesMap` valida PRESENCIA DE KEYS contra `TemplateDto.variables`
 * (contradicción #3) — no un mapa de valores fijos.
 *
 * Testea el SEAM completo: ruta→use case REAL→repo in-memory (NO se mockea el
 * use case). `campaignRepo` es el `InMemoryCampaignRepository` real (T3.1).
 */
import { CreateCampaign } from '@application/use-cases/messaging/CreateCampaign';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { TemplateNotApprovedError, MissingTemplateVariablesError, EmptySegmentError, UnfilteredSegmentError, ManualRecipientsNotFoundError } from '@domain/errors/messaging-bulk';
import type { CampaignSegmentSource, CampaignRecipientCandidate, ManualRecipientSource } from '@domain/ports/CustomerRepository';
import type { TemplateMessagingPort, TemplateDto } from '@domain/ports/TemplateMessagingPort';
import type { CreateCampaignInput } from '@application/dto/messaging-bulk.dto';

function makeSegmentSource(candidates: CampaignRecipientCandidate[]): CampaignSegmentSource {
  return { listSegmentRecipients: jest.fn().mockResolvedValue(candidates) };
}

/**
 * manual-recipients — fake del port narrow `ManualRecipientSource`. Devuelve SOLO
 * los ids que existen en `candidates` (subset), igual que el `findMany({id:{in}})`
 * real; el caller detecta faltantes por set-diff (MAN-3, fail-loud).
 */
function makeManualSource(candidates: CampaignRecipientCandidate[]): ManualRecipientSource {
  return {
    findRecipientCandidatesByIds: jest.fn(async (ids: string[]) =>
      candidates.filter((c) => ids.includes(c.clientId)),
    ),
  };
}

function emptyManualSource(): ManualRecipientSource {
  return { findRecipientCandidatesByIds: jest.fn().mockResolvedValue([]) };
}

function makeTemplatePort(templates: TemplateDto[]): TemplateMessagingPort {
  return {
    listTemplates: jest.fn().mockResolvedValue(templates),
    sendTemplate: jest.fn(),
  };
}

const APPROVED_TEMPLATE: TemplateDto = {
  contentSid: 'HXapproved',
  friendlyName: 'recordatorio_deuda',
  language: 'es',
  variables: { '1': 'nombre', '2': 'monto_deuda' },
  approvalStatus: 'approved',
  body: 'Hola {{1}}, tenés un saldo pendiente de {{2}}',
};

function makeCandidate(overrides: Partial<CampaignRecipientCandidate> = {}): CampaignRecipientCandidate {
  return {
    clientId: 'c-default',
    name: 'Default',
    phone: '3364000000',
    balanceDue: 1000,
    whatsappOptOutAt: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<CreateCampaignInput> = {}): CreateCampaignInput {
  return {
    name: 'Recordatorio deuda julio',
    templateRef: 'HXapproved',
    segment: { statuses: ['late'] },
    variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    createdById: 'user-1',
    ...overrides,
  };
}

describe('CreateCampaign', () => {
  it('CAMP-1: create exitoso — persiste Campaign pending + N CampaignRecipient queued, sendTemplate NUNCA invocado', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const segmentSource = makeSegmentSource([
      makeCandidate({ clientId: 'c1', phone: '3364111111' }),
      makeCandidate({ clientId: 'c2', phone: '3364222222' }),
      makeCandidate({ clientId: 'c3', phone: '3364333333' }),
    ]);
    const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
    const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

    const result = await uc.execute(makeInput());

    expect(result.status).toBe('pending');
    expect(result.total).toBe(3);

    const persisted = await campaignRepo.findById(result.campaignId);
    expect(persisted?.status).toBe('pending');
    expect(persisted?.total).toBe(3);
    expect(persisted?.sentCount).toBe(0);
    expect(persisted?.failedCount).toBe(0);
    expect(persisted?.skippedCount).toBe(0);
    expect(persisted?.optedOutCount).toBe(0);

    const recipients = await campaignRepo.listRecipients(result.campaignId);
    expect(recipients.total).toBe(3);
    expect(recipients.data.every((r) => r.status === 'queued')).toBe(true);

    expect(templatePort.sendTemplate).not.toHaveBeenCalled();
  });

  it('CAMP-2: template pending → TemplateNotApprovedError, no se crea Campaign ni CampaignRecipient', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1' })]);
    const templatePort = makeTemplatePort([{ ...APPROVED_TEMPLATE, approvalStatus: 'pending' }]);
    const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

    await expect(uc.execute(makeInput())).rejects.toThrow(TemplateNotApprovedError);

    const list = await campaignRepo.list({});
    expect(list.total).toBe(0); // campaignRepo sigue vacío
  });

  it('CAMP-2: templateRef inexistente en el proveedor → TemplateNotApprovedError (misma semántica, sin evidencia de aprobación)', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1' })]);
    const templatePort = makeTemplatePort([]); // el provider no conoce este templateRef
    const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

    await expect(uc.execute(makeInput({ templateRef: 'HXnoexiste' }))).rejects.toThrow(TemplateNotApprovedError);

    const list = await campaignRepo.list({});
    expect(list.total).toBe(0);
  });

  it('CAMP-3: falta una variable requerida → MissingTemplateVariablesError con `missing` correcto, nada persistido', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1' })]);
    const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
    const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

    const input = makeInput({ variablesMap: { '1': { source: 'name' } } }); // falta '2' (monto_deuda)

    let caught: unknown;
    try {
      await uc.execute(input);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MissingTemplateVariablesError);
    expect((caught as MissingTemplateVariablesError).missing).toEqual(['2']);
    const list = await campaignRepo.list({});
    expect(list.total).toBe(0);
  });

  it('CAMP-3: variables extra no declaradas NO bloquean la creación', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1' })]);
    const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
    const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

    const input = makeInput({
      variablesMap: {
        '1': { source: 'name' },
        '2': { source: 'balanceDue' },
        '3': { source: 'literal', value: 'extra no declarada' },
      },
    });

    const result = await uc.execute(input);

    expect(result.status).toBe('pending');
    const persisted = await campaignRepo.findById(result.campaignId);
    expect(persisted).not.toBeNull();
  });

  // FIX-14 — CAMP-4 ya NO es tautológico: pasa un segmento NO vacío que se filtra
  // A CERO por la lógica REAL de `resolveRecipients` (opt-out SEG-2 + teléfono
  // inválido SEG-4), en vez de un array vacío que nunca ejercitaba la exclusión.
  it('CAMP-4: segmento NO vacío pero todos excluidos por resolveRecipients (opt-out + inválido) → EmptySegmentError', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const segmentSource = makeSegmentSource([
      // opt-out (SEG-2): con FIX-11 el query ya no lo pre-filtra, llega y se excluye acá.
      makeCandidate({ clientId: 'c1', phone: '3364111111', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
      // teléfono basura (< 6 dígitos significativos, SEG-4).
      makeCandidate({ clientId: 'c2', phone: '123' }),
    ]);
    const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
    const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

    await expect(uc.execute(makeInput())).rejects.toThrow(EmptySegmentError);

    const list = await campaignRepo.list({});
    expect(list.total).toBe(0);
  });

  // ── FIX-8: segmento SIN criterio (apuntaría a toda la base) se RECHAZA ────────
  it('FIX-8: segmento sin statuses ni balance → UnfilteredSegmentError, nada persistido', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1' })]);
    const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
    const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

    await expect(uc.execute(makeInput({ segment: { statuses: [] } }))).rejects.toBeInstanceOf(UnfilteredSegmentError);

    const list = await campaignRepo.list({});
    expect(list.total).toBe(0);
  });

  it('FIX-8: segmento con balanceMin>0 (sin statuses) → OK (criterio presente)', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1', balanceDue: 5000 })]);
    const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
    const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

    const result = await uc.execute(makeInput({ segment: { statuses: [], balanceMin: 1000 } }));
    expect(result.status).toBe('pending');
  });

  // ── manual-recipients (MAN-1..MAN-4): lista manual combinable ────────────────
  describe('lista manual combinable (MAN-1..MAN-4)', () => {
    it('MAN-1 solo-manual: segmento sin criterio + manualClientIds → materializa los manuales, NO toca la fuente del segmento', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([]); // no debería llamarse (segmento sin criterio)
      const manualSource = makeManualSource([
        makeCandidate({ clientId: 'c1', phone: '3364111111' }),
        makeCandidate({ clientId: 'c2', phone: '3364222222' }),
      ]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource);

      const result = await uc.execute(makeInput({ segment: { statuses: [] }, manualClientIds: ['c1', 'c2'] }));

      expect(result.status).toBe('pending');
      expect(result.total).toBe(2);
      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.total).toBe(2);
      expect(recipients.data.map((r) => r.clientId).sort()).toEqual(['c1', 'c2']);
      // segmento sin criterio → jamás se resuelve contra la base (evita where:{}):
      expect(segmentSource.listSegmentRecipients).not.toHaveBeenCalled();
    });

    it('MAN-1 segmento + manual (unión disjunta): materializa los 3', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([
        makeCandidate({ clientId: 'c1', phone: '3364111111' }),
        makeCandidate({ clientId: 'c2', phone: '3364222222' }),
      ]);
      const manualSource = makeManualSource([makeCandidate({ clientId: 'c3', phone: '3364333333' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource);

      const result = await uc.execute(makeInput({ segment: { statuses: ['late'] }, manualClientIds: ['c3'] }));

      expect(result.total).toBe(3);
      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data.map((r) => r.clientId).sort()).toEqual(['c1', 'c2', 'c3']);
    });

    it('MAN-1 overlap: manualClientId que YA cae en el segmento → un solo recipient, sin error', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([
        makeCandidate({ clientId: 'c1', phone: '3364111111' }),
        makeCandidate({ clientId: 'c2', phone: '3364222222' }),
      ]);
      // c2 también viene por la lista manual (mismo clientId).
      const manualSource = makeManualSource([makeCandidate({ clientId: 'c2', phone: '3364222222' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource);

      const result = await uc.execute(makeInput({ segment: { statuses: ['late'] }, manualClientIds: ['c2'] }));

      expect(result.total).toBe(2);
      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data.map((r) => r.clientId).sort()).toEqual(['c1', 'c2']);
    });

    it('MAN-2: ni segmento ni lista manual → UnfilteredSegmentError, nada persistido', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, emptyManualSource());

      await expect(
        uc.execute(makeInput({ segment: { statuses: [] }, manualClientIds: [] })),
      ).rejects.toBeInstanceOf(UnfilteredSegmentError);

      const list = await campaignRepo.list({});
      expect(list.total).toBe(0);
    });

    it('MAN-3: un manualClientId inexistente → ManualRecipientsNotFoundError con missingClientIds, nada persistido', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([]);
      const manualSource = makeManualSource([makeCandidate({ clientId: 'c1', phone: '3364111111' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource);

      let caught: unknown;
      try {
        await uc.execute(makeInput({ segment: { statuses: [] }, manualClientIds: ['c1', 'no-existe'] }));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ManualRecipientsNotFoundError);
      expect((caught as ManualRecipientsNotFoundError).missingClientIds).toEqual(['no-existe']);
      const list = await campaignRepo.list({});
      expect(list.total).toBe(0);
    });

    it('MAN-4: manualClientId opt-out se excluye del envío SIN error (compliance no negociable)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([]);
      const manualSource = makeManualSource([
        makeCandidate({ clientId: 'c1', phone: '3364111111' }),
        makeCandidate({ clientId: 'c2', phone: '3364222222', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
      ]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource);

      const result = await uc.execute(makeInput({ segment: { statuses: [] }, manualClientIds: ['c1', 'c2'] }));

      expect(result.total).toBe(1);
      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data.map((r) => r.clientId)).toEqual(['c1']);
    });
  });

  // ── FIX-1: la unión también deduplica por TELÉFONO normalizado (cross-set) ────
  // Sin esto, un cliente manual con clientId distinto pero MISMO teléfono que uno
  // del segmento sobreviviría → 2 WhatsApp al mismo número (y resucitaría a un
  // colapsado por SEG-3). El del segmento gana; el manual colisionante se excluye.
  describe('FIX-1: dedup de la unión por teléfono normalizado (cross-set)', () => {
    it('FIX-1: segmento A(phone X) + manual B(clientId≠A, MISMO phone X) → un solo recipient (gana el del segmento)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'A', phone: '3364111111' })]);
      const manualSource = makeManualSource([makeCandidate({ clientId: 'B', phone: '3364111111' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource);

      const result = await uc.execute(makeInput({ segment: { statuses: ['late'] }, manualClientIds: ['B'] }));

      expect(result.total).toBe(1);
      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data.map((r) => r.clientId)).toEqual(['A']); // el del segmento, NO B
    });

    it('FIX-1 no-regresión: manual con teléfono DISTINTO al del segmento SÍ entra (los dos se materializan)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'A', phone: '3364111111' })]);
      const manualSource = makeManualSource([makeCandidate({ clientId: 'B', phone: '3364222222' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource);

      const result = await uc.execute(makeInput({ segment: { statuses: ['late'] }, manualClientIds: ['B'] }));

      expect(result.total).toBe(2);
      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data.map((r) => r.clientId).sort()).toEqual(['A', 'B']);
    });
  });
});
