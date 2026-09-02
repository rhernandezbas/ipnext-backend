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
import { TemplateNotApprovedError, MissingTemplateVariablesError, EmptySegmentError, UnfilteredSegmentError, ManualRecipientsNotFoundError, BulkRecipientsNotPermittedError, TaskStageNotEligibleError } from '@domain/errors/messaging-bulk';
import type { CampaignSegmentSource, CampaignRecipientCandidate, ManualRecipientSource } from '@domain/ports/CustomerRepository';
import type { TemplateMessagingPort, TemplateDto } from '@domain/ports/TemplateMessagingPort';
import type { CreateCampaignInput } from '@application/dto/messaging-bulk.dto';
import type { TaskRecipientSource } from '@domain/ports/TaskRecipientSource';
import type { TaskStageRecipientConfigRepository } from '@domain/ports/TaskStageRecipientConfigRepository';

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

/** bulk-task-recipients (B5.3) — fake narrow del 5to dominio "Tarea" (resolución). */
function makeTaskSource(clientIds: string[], noCustomerCount = 0): TaskRecipientSource {
  return {
    listClientIdsByOpenTaskStages: jest.fn(async () => clientIds),
    listOpenTasksByStages: jest.fn(async () => clientIds.map((c: string, i: number) => ({ taskId: `t-${i}-${c}`, clientId: c, fromStageId: 'stageA' }))),
    countOpenTasksWithoutCustomer: jest.fn(async () => noCustomerCount),
  };
}

/** bulk-task-recipients (B5.3) — fake narrow de la config de elegibilidad. */
function makeTaskStageConfigRepo(mapped: string[]): TaskStageRecipientConfigRepository {
  return {
    listMappedStageIds: jest.fn(async () => mapped),
    getMappedStages: jest.fn(async () => []),
    replaceMappedStages: jest.fn(async () => undefined),
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

  // ── bulk-csv-recipients (CSV-1..CSV-3): 4to dominio, contactos crudos ────────
  describe('bulk-csv-recipients (CSV-1..CSV-3): manualContacts', () => {
    it('CSV-1 solo-CSV: segmento sin criterio + manualContacts → materializa los contactos, NO toca la fuente del segmento', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([]); // universo vacío: ningún contacto matchea
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(
        makeInput({
          segment: { statuses: [] },
          manualContacts: [
            { name: 'Ana', phone: '11 2345-6789' },
            { name: 'Beto', phone: '011 15-3456-7890' },
          ],
        }),
      );

      expect(result.status).toBe('pending');
      expect(result.total).toBe(2);
      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data.every((r) => r.clientId === null)).toBe(true);
      expect(recipients.data.map((r) => r.contactName).sort()).toEqual(['Ana', 'Beto']);
    });

    it('CSV-1 unión: segmento + manual + CSV → materializa los 3 (no-cliente incluido)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111' })]);
      const manualSource = makeManualSource([makeCandidate({ clientId: 'c2', phone: '3364222222' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource);

      const result = await uc.execute(
        makeInput({
          segment: { statuses: ['late'] },
          manualClientIds: ['c2'],
          manualContacts: [{ name: 'Crudo', phone: '3364333333' }],
        }),
      );

      expect(result.total).toBe(3);
      const recipients = await campaignRepo.listRecipients(result.campaignId);
      // Array.sort() por default stringifica ('null' > 'c2' alfabéticamente) — el
      // orden real no importa acá, solo el CONJUNTO de clientIds presentes.
      expect(recipients.data.map((r) => r.clientId).sort()).toEqual(['c1', 'c2', null]);
      const crudo = recipients.data.find((r) => r.clientId === null);
      expect(crudo?.contactName).toBe('Crudo');
    });

    it('CSV-2: contacto CSV que vincula a un Client existente → materializa VINCULADO (clientId real, contactName null)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const client = makeCandidate({ clientId: 'k1', phone: '3364111111', name: 'Cliente Real' });
      const segmentSource = makeSegmentSource([client]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(
        makeInput({ segment: { statuses: [] }, manualContacts: [{ name: 'Como lo anotó el operador', phone: '3364111111' }] }),
      );

      expect(result.total).toBe(1);
      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data[0]!.clientId).toBe('k1');
      expect(recipients.data[0]!.contactName).toBeNull();
    });

    // external-bulk-messaging (D4.e puntos 1-6, SEND-10) — `manualContacts[].variables`
    // viaja punta a punta hasta `CampaignRecipient.variables`. Paridad Prisma/InMemory
    // del CAMPO en sí ya está pineada a nivel repo (B1,
    // `PrismaCampaignRepository.variables.test.ts` + `InMemoryCampaignRepository.test.ts`
    // — ambos adapters tratan `row.variables` idéntico sin importar su origen); acá se
    // prueba la parte NUEVA: que `CreateCampaign` efectivamente puebla ese campo desde
    // `manualContacts[].variables` para los 3 caminos (crudo/vinculado/ausente).
    it('D4.e: manualContact CRUDO con variables → CampaignRecipient.variables persistido MERGEADO tal cual', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([]); // universo vacío: no matchea a ningún Client
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(
        makeInput({
          segment: { statuses: [] },
          manualContacts: [{ name: 'Ana', phone: '11 2345-6789', variables: { '1': 'Ana', '2': '$500' } }],
        }),
      );

      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data[0]!.clientId).toBeNull();
      expect(recipients.data[0]!.variables).toEqual({ '1': 'Ana', '2': '$500' });
    });

    it('D4.e: manualContact VINCULADO a un Client con variables → CampaignRecipient.variables persistido igual (no se pierde al linkear)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const client = makeCandidate({ clientId: 'k1', phone: '3364111111', name: 'Cliente Real' });
      const segmentSource = makeSegmentSource([client]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(
        makeInput({
          segment: { statuses: [] },
          manualContacts: [{ name: 'Cualquiera', phone: '3364111111', variables: { '1': 'Override' } }],
        }),
      );

      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data[0]!.clientId).toBe('k1');
      expect(recipients.data[0]!.variables).toEqual({ '1': 'Override' });
    });

    it('D4.e: manualContact SIN variables → CampaignRecipient.variables persiste null (no {}), no-regresión', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(
        makeInput({
          segment: { statuses: [] },
          manualContacts: [{ name: 'Sin variables', phone: '11 2345-6789' }],
        }),
      );

      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data[0]!.variables).toBeNull();
    });

    it('D4.e: manualContact EXCLUIDO (opt-out) con variables → no persiste ningún recipient (un excluido no se envía)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const optedOutClient = makeCandidate({
        clientId: 'k1',
        phone: '3364111111',
        whatsappOptOutAt: '2026-01-01T00:00:00.000Z',
      });
      const segmentSource = makeSegmentSource([optedOutClient]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      await expect(
        uc.execute(
          makeInput({
            segment: { statuses: [] },
            manualContacts: [{ name: 'Opt-out', phone: '3364111111', variables: { '1': 'X' } }],
          }),
        ),
      ).rejects.toThrow(EmptySegmentError); // el único contacto quedó excluido

      const list = await campaignRepo.list({});
      expect(list.total).toBe(0);
    });

    it('MAN-2/CSV-1: los TRES vacíos (segmento sin criterio + sin manuales + sin manualContacts) → UnfilteredSegmentError', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      await expect(
        uc.execute(makeInput({ segment: { statuses: [] }, manualContacts: [] })),
      ).rejects.toBeInstanceOf(UnfilteredSegmentError);
      const list = await campaignRepo.list({});
      expect(list.total).toBe(0);
    });

    it('CSV-3: fila con teléfono basura NO bloquea el create — se materializa solo la válida', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(
        makeInput({
          segment: { statuses: [] },
          manualContacts: [
            { name: 'Ana', phone: '11 2345-6789' },
            { name: 'Beto', phone: 'no-es-numero' },
          ],
        }),
      );

      expect(result.total).toBe(1);
      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data[0]!.contactName).toBe('Ana');
    });
  });

  // ── bulk-granular-perms: BLOQUEO por estado de cliente + números crudos ───────
  describe('bulk-granular-perms (allowedBulkActions)', () => {
    it('unión con un blocked y creador SIN bulk_blocked → BulkRecipientsNotPermittedError con ["blocked"], nada persistido', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'blocked' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      let caught: unknown;
      try {
        await uc.execute(makeInput({ segment: { statuses: ['blocked'] }, allowedBulkActions: new Set(['bulk']) }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BulkRecipientsNotPermittedError);
      expect((caught as BulkRecipientsNotPermittedError).forbidden).toEqual(['blocked']);
      const list = await campaignRepo.list({});
      expect(list.total).toBe(0);
    });

    it('con TODOS los permisos de los estados presentes → OK', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'blocked' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(
        makeInput({ segment: { statuses: ['blocked'] }, allowedBulkActions: new Set(['bulk', 'bulk_blocked']) }),
      );
      expect(result.status).toBe('pending');
    });

    it('números crudos (manualContacts) sin bulk_numbers → throw con ["números"]', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      let caught: unknown;
      try {
        await uc.execute(
          makeInput({
            segment: { statuses: [] },
            manualContacts: [{ name: 'Ana', phone: '11 2345-6789' }],
            allowedBulkActions: new Set(['bulk']),
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BulkRecipientsNotPermittedError);
      expect((caught as BulkRecipientsNotPermittedError).forbidden).toEqual(['números']);
    });

    it('super_admin (set con "*") → OK aunque falten permisos de estado', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'blocked' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(
        makeInput({ segment: { statuses: ['blocked'] }, allowedBulkActions: new Set(['*']) }),
      );
      expect(result.status).toBe('pending');
    });

    it('allowedBulkActions undefined → sin enforcement (backcompat), NO bloquea', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'blocked' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(makeInput({ segment: { statuses: ['blocked'] } }));
      expect(result.status).toBe('pending');
    });

    it('persiste el snapshot recipientStatuses (distinct, sin crudos) + hasRawRecipients', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([
        makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'late' }),
        makeCandidate({ clientId: 'c2', phone: '3364222222', status: 'blocked' }),
      ]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(
        makeInput({
          segment: { statuses: ['late', 'blocked'] },
          manualContacts: [{ name: 'Crudo', phone: '11 2345-6789' }],
          allowedBulkActions: new Set(['*']),
        }),
      );

      const persisted = await campaignRepo.findById(result.campaignId);
      expect(persisted?.recipientStatuses.sort()).toEqual(['blocked', 'late']);
      expect(persisted?.hasRawRecipients).toBe(true);
    });
  });

  // ── var-fallback: `fallback` opcional por entry en variablesMap ──────────────
  describe('var-fallback (variablesMap.fallback opcional)', () => {
    it('variablesMap con `fallback` por entry se acepta y se persiste verbatim en variableSpec', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(
        makeInput({
          variablesMap: {
            '1': { source: 'name', fallback: 'cliente' },
            '2': { source: 'balanceDue', fallback: '—' },
          },
        }),
      );

      expect(result.status).toBe('pending');
      const persisted = await campaignRepo.findById(result.campaignId);
      expect(persisted?.variableSpec['1']).toEqual({ source: 'name', fallback: 'cliente' });
      expect(persisted?.variableSpec['2']).toEqual({ source: 'balanceDue', fallback: '—' });
    });

    it('variablesMap SIN `fallback` sigue siendo válido (backcompat, entry sin la clave)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(makeInput()); // variablesMap por defecto, sin fallback
      expect(result.status).toBe('pending');
      const persisted = await campaignRepo.findById(result.campaignId);
      expect(persisted?.variableSpec['1']).toEqual({ source: 'name' });
      expect(persisted?.variableSpec['2']).toEqual({ source: 'balanceDue' });
    });
  });

  // ── bulk-task-recipients (TASK-1, TASK-2, TASK-8, TASK-9): 5to dominio "Tarea" ──
  describe('bulk-task-recipients (TASK-1, TASK-2, TASK-8, TASK-9): taskStageIds', () => {
    it('TASK-2: taskStageIds NO mapeado → TaskStageNotEligibleError, nada persistido', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const taskConfigRepo = makeTaskStageConfigRepo(['stageA']);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, undefined, undefined, taskConfigRepo);

      await expect(
        uc.execute(makeInput({ segment: { statuses: [] }, taskStageIds: ['stageA', 'stageB'] })),
      ).rejects.toBeInstanceOf(TaskStageNotEligibleError);
      const list = await campaignRepo.list({});
      expect(list.total).toBe(0);
    });

    it('TASK-1: combinación con manual — manualClientIds:["c1"] + taskStageIds:["stageA"] (mapeado, c2 con tarea abierta) → materializa 2 recipients', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([]);
      const manualSource = makeManualSource([
        makeCandidate({ clientId: 'c1', phone: '3364111111' }),
        makeCandidate({ clientId: 'c2', phone: '3364222222' }),
      ]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const taskConfigRepo = makeTaskStageConfigRepo(['stageA']);
      const taskSource = makeTaskSource(['c2']);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource, taskSource, taskConfigRepo);

      const result = await uc.execute(
        makeInput({ segment: { statuses: [] }, manualClientIds: ['c1'], taskStageIds: ['stageA'] }),
      );

      expect(result.total).toBe(2);
      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data.map((r) => r.clientId).sort()).toEqual(['c1', 'c2']);
    });

    it('TASK-8 escenario 1: snapshot inmutable — desmapear el stage DESPUÉS del create NO altera los recipients ya materializados', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([]);
      const manualSource = makeManualSource([makeCandidate({ clientId: 'c1', phone: '3364111111' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const taskConfigRepo = makeTaskStageConfigRepo(['stageA']);
      const taskSource = makeTaskSource(['c1']);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource, taskSource, taskConfigRepo);

      const result = await uc.execute(makeInput({ segment: { statuses: [] }, taskStageIds: ['stageA'] }));
      expect(result.total).toBe(1);

      // El admin desmapea stageA de la config DESPUÉS del create (sin re-invocar CreateCampaign).
      await taskConfigRepo.replaceMappedStages([]);

      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.total).toBe(1); // sin cambios — snapshot ya congelado, ninguna re-resolución ocurre
      expect(recipients.data[0]!.clientId).toBe('c1');
    });

    it('TASK-8 escenario 2: cerrar la tarea del cliente DESPUÉS del create NO altera los recipients ya materializados', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([]);
      const manualSource = makeManualSource([makeCandidate({ clientId: 'c1', phone: '3364111111' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const taskConfigRepo = makeTaskStageConfigRepo(['stageA']);
      // taskSource MUTABLE: simula que la tarea se cierra DESPUÉS del create (el port ya no la devolvería).
      let openClientIds = ['c1'];
      const taskSource: TaskRecipientSource = {
        listClientIdsByOpenTaskStages: jest.fn(async () => openClientIds),
        listOpenTasksByStages: jest.fn(async () => openClientIds.map((c: string, i: number) => ({ taskId: `t-${i}-${c}`, clientId: c, fromStageId: 'stageA' }))),
        countOpenTasksWithoutCustomer: jest.fn(async () => 0),
      };
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource, taskSource, taskConfigRepo);

      const result = await uc.execute(makeInput({ segment: { statuses: [] }, taskStageIds: ['stageA'] }));
      expect(result.total).toBe(1);

      openClientIds = []; // la tarea se cierra

      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.total).toBe(1); // snapshot ya congelado — el envío NUNCA re-resuelve (SEND-5 solo re-chequea el CLIENTE)
      expect(recipients.data[0]!.clientId).toBe('c1');
    });

    it('TASK-9: cliente status:"blocked" resuelto ÚNICAMENTE por taskStageIds + operador SIN bulk_blocked → BulkRecipientsNotPermittedError (el mecanismo existente ya cubre source:"task", sin código nuevo)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([]);
      const manualSource = makeManualSource([makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'blocked' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const taskConfigRepo = makeTaskStageConfigRepo(['stageA']);
      const taskSource = makeTaskSource(['c1']);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource, taskSource, taskConfigRepo);

      let caught: unknown;
      try {
        await uc.execute(
          makeInput({ segment: { statuses: [] }, taskStageIds: ['stageA'], allowedBulkActions: new Set(['bulk']) }),
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(BulkRecipientsNotPermittedError);
      expect((caught as BulkRecipientsNotPermittedError).forbidden).toEqual(['blocked']);
      const list = await campaignRepo.list({});
      expect(list.total).toBe(0);
    });
  });

  // ── campaign-chatwoot-label (CLBL-6): pass-through de chatwootLabel ──────────
  describe('campaign-chatwoot-label (CLBL-6): chatwootLabel pass-through', () => {
    it('input CON chatwootLabel → persiste el valor TAL CUAL, cero llamada a chatwootGateway (Decisión D)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(makeInput({ chatwootLabel: 'promo-julio' }));

      const persisted = await campaignRepo.findById(result.campaignId);
      expect(persisted?.chatwootLabel).toBe('promo-julio');
    });

    it('input SIN chatwootLabel → persiste `null`, sin cambios (ausencia intacta)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(makeInput());

      const persisted = await campaignRepo.findById(result.campaignId);
      expect(persisted?.chatwootLabel).toBeNull();
    });

    it('chatwootLabel que NO existe en ningún catálogo → igual persiste (pass-through, cero validación)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const segmentSource = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111' })]);
      const templatePort = makeTemplatePort([APPROVED_TEMPLATE]);
      const uc = new CreateCampaign(campaignRepo, segmentSource, templatePort);

      const result = await uc.execute(makeInput({ chatwootLabel: 'label-borrado' }));

      const persisted = await campaignRepo.findById(result.campaignId);
      expect(persisted?.chatwootLabel).toBe('label-borrado');
    });
  });
});
