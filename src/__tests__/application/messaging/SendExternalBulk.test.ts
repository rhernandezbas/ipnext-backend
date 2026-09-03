/**
 * external-bulk-messaging (Batch 3, tasks 3.2-3.3, 3.7) — `SendExternalBulk`.
 * Matriz spec↔test: cada `describe` mapea a UN requirement (SEND-1..SEND-10,
 * KS-1) de `openspec/changes/external-bulk-messaging/specs/external-bulk-messaging/spec.md`.
 *
 * Adapters SIEMPRE in-memory + `CreateCampaign` REAL (reuso, sin tocar su
 * spec) + un fake `CampaignStarter` mínimo. JAMÁS se mockea Prisma ni el use
 * case bajo test.
 */
import { SendExternalBulk } from '@application/use-cases/messaging/SendExternalBulk';
import { CreateCampaign } from '@application/use-cases/messaging/CreateCampaign';
import { InMemoryExternalBulkPreviewRepository } from '@infrastructure/adapters/in-memory/InMemoryExternalBulkPreviewRepository';
import { InMemoryExternalBulkMessagingConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryExternalBulkMessagingConfigRepository';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryCreditBalancePort } from '@infrastructure/adapters/in-memory/InMemoryCreditBalancePort';
import { InMemoryMessagingRatesConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryMessagingRatesConfigRepository';
import { bootstrapApiMessagingUser } from '@infrastructure/bootstrap/bootstrapApiMessagingUser';
import { FakeChatwootGateway } from '../../helpers/FakeChatwootGateway';
import { externalBulkPayloadHash } from '@application/use-cases/messaging/externalBulkPayloadHash';
import type { CampaignSegmentSource, CampaignRecipientCandidate, CampaignSegmentFilter } from '@domain/ports/CustomerRepository';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';
import type { CampaignStarter } from '@domain/ports/CampaignStarter';
import type { ExternalBulkPreviewCreateData } from '@domain/ports/ExternalBulkPreviewRepository';
import {
  FeatureExternalBulkDisabledError,
  ExternalBulkValidationError,
  CapExceededError,
  ChatwootLabelNotFoundError,
  PreviewNotFoundError,
  PreviewExpiredError,
  PreviewAlreadyConsumedError,
  PreviewPayloadMismatchError,
  IdempotencyKeyConflictError,
  CampaignRunnerBusyError,
  InsufficientCreditError,
  CreditUnavailableError,
} from '@domain/errors/external-bulk-messaging';
import { TemplateNotApprovedError, BulkRecipientsNotPermittedError } from '@domain/errors/messaging-bulk';
import { UniqueConstraintViolationError } from '@domain/errors/persistence';
import { BULK_NUMBERS_ACTION } from '@domain/services/bulkRecipientAuthorization';

const NOW = new Date('2026-09-02T12:00:00.000Z');
const FLAG_KEY = 'messaging-external-bulk-enabled';

const TEMPLATE: TemplateDto = {
  contentSid: 'HXpromo1',
  friendlyName: 'promo_setiembre',
  language: 'es',
  variables: { '1': 'Nombre' },
  approvalStatus: 'approved',
  body: 'Hola {{1}}',
};

function makeCandidate(overrides: Partial<CampaignRecipientCandidate> = {}): CampaignRecipientCandidate {
  return {
    clientId: 'c-default',
    name: 'Cliente Default',
    phone: '3364000000',
    balanceDue: 0,
    whatsappOptOutAt: null,
    status: 'active',
    ...overrides,
  };
}

function makeSegmentSource(universe: CampaignRecipientCandidate[]): CampaignSegmentSource {
  return { listSegmentRecipients: async (_s: CampaignSegmentFilter) => universe };
}

class FakeCampaignStarter implements CampaignStarter {
  public calls: string[] = [];
  public accepted = true;
  /**
   * fix wave F1 (F3) — hook para simular el EFECTO de un envio aceptado (que
   * la plata se comprometa). Sin esto, dos `execute()` concurrentes leen el
   * mismo saldo y no hay forma de distinguir "serializado" de "no serializado".
   */
  public onStart?: (campaignId: string) => void | Promise<void>;
  async start(campaignId: string): Promise<{ accepted: boolean }> {
    this.calls.push(campaignId);
    if (this.onStart) await this.onStart(campaignId);
    return { accepted: this.accepted };
  }
}

interface Setup {
  useCase: SendExternalBulk;
  previewRepo: InMemoryExternalBulkPreviewRepository;
  configRepo: InMemoryExternalBulkMessagingConfigRepository;
  campaignRepo: InMemoryCampaignRepository;
  templatePort: InMemoryTemplateMessagingGateway;
  chatwootGateway: FakeChatwootGateway;
  featureFlags: InMemoryFeatureFlagRepository;
  rbacUserRepo: InMemoryRbacUserRepository;
  campaignStarter: FakeCampaignStarter;
  creditPort: InMemoryCreditBalancePort;
  ratesRepo: InMemoryMessagingRatesConfigRepository;
  apiMessagingUserId: string;
}

async function setup(
  opts: {
    templates?: TemplateDto[];
    clients?: CampaignRecipientCandidate[];
    flagEnabled?: boolean;
    bootstrapApiMessaging?: boolean;
    chatwootLabels?: string[];
    /** twilio-credit-guard (3.1) — saldo/tarifas del gate. Defaults: saldo AMPLIO, tarifas default. */
    creditAmount?: string;
    creditCurrency?: string;
    creditFails?: boolean;
    /** fix wave F1 (F1) — reloj del twin de credito (ms), para ejercitar el TTL de 60s. */
    creditNow?: () => number;
    ratesPatch?: { currency: string; utilityRate: string; marketingRate: string; authenticationRate: string; providerFee: string };
  } = {},
): Promise<Setup> {
  const previewRepo = new InMemoryExternalBulkPreviewRepository({ now: () => NOW });
  const configRepo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
  const campaignRepo = new InMemoryCampaignRepository({ now: () => NOW });
  const templatePort = new InMemoryTemplateMessagingGateway({ templates: opts.templates ?? [TEMPLATE] });
  const chatwootGateway = new FakeChatwootGateway();
  chatwootGateway.accountLabelsResult = (opts.chatwootLabels ?? []).map((title) => ({ title, color: 'blue' }));
  const featureFlags = new InMemoryFeatureFlagRepository();
  if (opts.flagEnabled !== false) {
    featureFlags.seed(FLAG_KEY, true);
  }
  const rbacUserRepo = new InMemoryRbacUserRepository();
  let apiMessagingUserId = '';
  if (opts.bootstrapApiMessaging !== false) {
    const bootstrap = await bootstrapApiMessagingUser(rbacUserRepo, { passwordHash: 'unusable-hash' });
    apiMessagingUserId = bootstrap.id;
  }
  const segmentSource = makeSegmentSource(opts.clients ?? []);
  const createCampaign = new CreateCampaign(campaignRepo, segmentSource, templatePort);
  const campaignStarter = new FakeCampaignStarter();
  // twilio-credit-guard (3.1) — saldo AMPLIO por default (10000 USD) para que
  // los tests de OTROS requirements (SEND-1..SEND-10, ya existentes) no
  // rebotEN contra el gate de crédito por casualidad.
  const creditPort = new InMemoryCreditBalancePort({
    amount: opts.creditAmount ?? '10000.0000',
    currency: opts.creditCurrency ?? 'USD',
    fetchedAt: NOW,
    failNext: opts.creditFails ?? false,
    // fix wave F1 (F1) — reloj inyectable: el twin ahora tiene cache REAL de
    // 60s, igual que `TwilioCreditBalanceGateway`.
    now: opts.creditNow ?? (() => NOW.getTime()),
  });
  const ratesRepo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
  if (opts.ratesPatch) {
    await ratesRepo.set(opts.ratesPatch);
  }

  const useCase = new SendExternalBulk(
    previewRepo,
    configRepo,
    campaignRepo,
    templatePort,
    chatwootGateway,
    featureFlags,
    rbacUserRepo,
    createCampaign,
    campaignStarter,
    creditPort,
    ratesRepo,
    () => NOW,
  );

  return {
    useCase,
    previewRepo,
    configRepo,
    campaignRepo,
    templatePort,
    chatwootGateway,
    featureFlags,
    rbacUserRepo,
    campaignStarter,
    creditPort,
    ratesRepo,
    apiMessagingUserId,
  };
}

/** Molde ValidateExternalBulk — persiste un preview YA "validado", con payloadHash correcto por default. */
function buildPreviewData(opts: {
  templateRef?: string;
  templateName?: string;
  variables?: Record<string, string>;
  chatwootLabel?: string | null;
  recipients: { phoneE164: string; phoneNormalized?: string; name: string; variables: Record<string, string> }[];
  invalid?: { input: string; reason: string; missingVariables?: string[] }[];
  expiresAt?: string;
  wrongHash?: boolean;
}): ExternalBulkPreviewCreateData {
  const templateName = opts.templateName ?? TEMPLATE.friendlyName;
  const variables = opts.variables ?? {};
  const chatwootLabel = opts.chatwootLabel ?? null;
  const recipients = opts.recipients.map((r) => ({
    phoneE164: r.phoneE164,
    phoneNormalized: r.phoneNormalized ?? r.phoneE164,
    name: r.name,
    variables: r.variables,
  }));
  const invalid = opts.invalid ?? [];
  const payloadHash = opts.wrongHash
    ? 'deadbeef-wrong-hash'
    : externalBulkPayloadHash({
        templateName,
        variables,
        chatwootLabel,
        recipients: [
          ...recipients.map((r) => ({ phone: r.phoneE164, name: r.name, variables: r.variables })),
          ...invalid.map((i) => ({ phone: i.input })),
        ],
      });
  return {
    payloadHash,
    templateRef: opts.templateRef ?? TEMPLATE.contentSid,
    templateName,
    variables,
    chatwootLabel,
    recipients,
    invalid,
    validCount: recipients.length,
    invalidCount: invalid.length,
    expiresAt: opts.expiresAt ?? new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
  };
}

const ONE_RECIPIENT = [{ phoneE164: '+5491123456789', name: 'Ana', variables: { '1': 'Ana' } }];

describe('SendExternalBulk', () => {
  describe('SEND-1 — forma del input', () => {
    it('falta previewId → ExternalBulkValidationError (400)', async () => {
      const { useCase } = await setup();
      await expect(useCase.execute({ previewId: '' }, 'key-1')).rejects.toThrow(ExternalBulkValidationError);
    });

    it('falta Idempotency-Key → ExternalBulkValidationError (400), sin tocar el preview', async () => {
      const { useCase, previewRepo } = await setup();
      const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      await expect(useCase.execute({ previewId: preview.id }, undefined)).rejects.toThrow(ExternalBulkValidationError);

      expect((await previewRepo.findById(preview.id))?.consumedAt).toBeNull();
    });
  });

  describe('KS-1 — kill-switch', () => {
    it('flag OFF → FeatureExternalBulkDisabledError (403), sin crear Campaign ni consumir', async () => {
      const { useCase, previewRepo, campaignRepo } = await setup({ flagEnabled: false });
      const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      await expect(useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(FeatureExternalBulkDisabledError);

      expect((await campaignRepo.list({})).total).toBe(0);
      expect((await previewRepo.findById(preview.id))?.consumedAt).toBeNull();
    });

    it('repo de flags lanza → fail-safe a OFF (403)', async () => {
      const { useCase, previewRepo, featureFlags } = await setup();
      const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
      jest.spyOn(featureFlags, 'get').mockRejectedValue(new Error('db down'));

      await expect(useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(FeatureExternalBulkDisabledError);
    });
  });

  describe('GUARD-0 — idempotencia (molde SendTemplateMessage.ts:116)', () => {
    it('SEND-7: misma key usada por OTRO previewId → IdempotencyKeyConflictError (409), Campaign original intacta, CERO nueva Campaign', async () => {
      const { useCase, previewRepo, campaignRepo, campaignStarter } = await setup();
      const previewA = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
      const previewB = await previewRepo.create(
        buildPreviewData({ recipients: [{ phoneE164: '+5491198765432', name: 'Beto', variables: { '1': 'Beto' } }] }),
      );

      const first = await useCase.execute({ previewId: previewA.id }, 'key-1');
      expect(first.accepted).toBe(true);

      await expect(useCase.execute({ previewId: previewB.id }, 'key-1')).rejects.toThrow(IdempotencyKeyConflictError);

      expect((await campaignRepo.list({})).total).toBe(1); // ninguna Campaign nueva
      expect(campaignStarter.calls).toEqual([first.campaignId]); // el runner NUNCA arrancó para B
    });

    it('SEND-6: MISMA key + MISMO previewId ya consumido → responde con la Campaign YA creada, CERO segunda Campaign', async () => {
      const { useCase, previewRepo, campaignRepo } = await setup();
      const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      const first = await useCase.execute({ previewId: preview.id }, 'key-1');
      const second = await useCase.execute({ previewId: preview.id }, 'key-1');

      expect(second.campaignId).toBe(first.campaignId);
      expect(second.resumed).toBe(true);
      expect((await campaignRepo.list({})).total).toBe(1);
    });
  });

  describe('SEND-2 — ciclo de vida del preview', () => {
    it('previewId inexistente → PreviewNotFoundError (404)', async () => {
      const { useCase } = await setup();
      await expect(useCase.execute({ previewId: 'nope' }, 'key-1')).rejects.toThrow(PreviewNotFoundError);
    });

    it('preview vencido y no consumido → PreviewExpiredError (410), sin crear Campaign', async () => {
      const { useCase, previewRepo, campaignRepo } = await setup();
      const preview = await previewRepo.create(
        buildPreviewData({ recipients: ONE_RECIPIENT, expiresAt: new Date(NOW.getTime() - 1000).toISOString() }),
      );

      await expect(useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(PreviewExpiredError);

      expect((await campaignRepo.list({})).total).toBe(0);
    });

    it('preview ya consumido por OTRA key → PreviewAlreadyConsumedError (409), sin crear segunda Campaign', async () => {
      const { useCase, previewRepo, campaignRepo } = await setup();
      const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
      await previewRepo.markConsumed(preview.id, 'campaign-other');

      await expect(useCase.execute({ previewId: preview.id }, 'key-2')).rejects.toThrow(PreviewAlreadyConsumedError);

      expect((await campaignRepo.list({})).total).toBe(0);
    });
  });

  describe('SEND-3 — mismatch de payload', () => {
    it('hash re-calculado no matchea el guardado (preview mutado en DB) → PreviewPayloadMismatchError (409), sin crear ni consumir', async () => {
      const { useCase, previewRepo, campaignRepo } = await setup();
      const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT, wrongHash: true }));

      await expect(useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(PreviewPayloadMismatchError);

      expect((await campaignRepo.list({})).total).toBe(0);
      expect((await previewRepo.findById(preview.id))?.consumedAt).toBeNull();
    });
  });

  describe('SEND-4 — re-validación completa al momento del send', () => {
    it('flag pasó a OFF DESPUÉS del validate → FeatureExternalBulkDisabledError (403), sin crear Campaign ni consumir el preview', async () => {
      const { useCase, previewRepo, campaignRepo, featureFlags } = await setup();
      const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
      featureFlags.seed(FLAG_KEY, false);

      await expect(useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(FeatureExternalBulkDisabledError);

      expect((await campaignRepo.list({})).total).toBe(0);
      expect((await previewRepo.findById(preview.id))?.consumedAt).toBeNull();
    });

    it('template pasó a pending/rejected DESPUÉS del validate → TemplateNotApprovedError (422), sin crear Campaign', async () => {
      const { useCase, previewRepo, templatePort, campaignRepo } = await setup();
      const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
      jest.spyOn(templatePort, 'listTemplates').mockResolvedValue([{ ...TEMPLATE, approvalStatus: 'pending' }]);

      await expect(useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(TemplateNotApprovedError);

      expect((await campaignRepo.list({})).total).toBe(0);
    });

    it('label de Chatwoot del preview ya NO existe en el catálogo vivo al momento del send → ChatwootLabelNotFoundError (422)', async () => {
      const { useCase, previewRepo, campaignRepo } = await setup({ chatwootLabels: [] });
      const preview = await previewRepo.create(
        buildPreviewData({ chatwootLabel: 'promo-agosto', recipients: ONE_RECIPIENT }),
      );

      await expect(useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(ChatwootLabelNotFoundError);

      expect((await campaignRepo.list({})).total).toBe(0);
    });

    it('cupo diario agotado por OTRA campaña api-messaging desde el validate → CapExceededError (422), sin crear Campaign', async () => {
      const { useCase, previewRepo, configRepo, campaignRepo, apiMessagingUserId } = await setup();
      await configRepo.set({ maxPerRequest: 500, maxPerDay: 1 });
      const other = await campaignRepo.create({
        name: 'other',
        templateRef: TEMPLATE.contentSid,
        segment: { statuses: [] },
        variableSpec: {},
        total: 1,
        createdById: apiMessagingUserId,
      });
      const [r] = await campaignRepo.bulkCreateRecipients(other.id, [
        { clientId: null, contactName: 'X', phoneNormalized: '111', phoneE164: '+549111' },
      ]);
      await campaignRepo.updateRecipient(r!.id, { status: 'sent', sentAt: NOW.toISOString() });

      const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      await expect(useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(CapExceededError);

      expect((await campaignRepo.list({})).total).toBe(1); // solo "other", ninguna nueva
    });

    it('recipient opt-out DESPUÉS del validate → excluido de la Campaign creada, no se le envía', async () => {
      const optedOutClient = makeCandidate({ clientId: 'k1', phone: '3364111111', whatsappOptOutAt: NOW.toISOString() });
      const { useCase, previewRepo, campaignRepo } = await setup({ clients: [optedOutClient] });
      const preview = await previewRepo.create(
        buildPreviewData({
          recipients: [
            { phoneE164: '+5493364111111', name: 'Opt-out', variables: { '1': 'X' } },
            { phoneE164: '+5491123456789', name: 'Sobrevive', variables: { '1': 'Y' } },
          ],
        }),
      );

      const result = await useCase.execute({ previewId: preview.id }, 'key-1');

      expect(result.total).toBe(1);
      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data).toHaveLength(1);
      expect(recipients.data[0]!.phoneE164).toBe('+5491123456789');
    });
  });

  describe('SEND-5 — creación de la Campaign', () => {
    it('recipient sin name real (name === phone del preview) → manualContact.name = phone E.164, no vacío', async () => {
      const { useCase, previewRepo, campaignRepo } = await setup();
      const preview = await previewRepo.create(
        buildPreviewData({ recipients: [{ phoneE164: '+5491123456789', name: '+5491123456789', variables: { '1': 'Ana' } }] }),
      );

      const result = await useCase.execute({ previewId: preview.id }, 'key-1');

      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data[0]!.contactName).toBe('+5491123456789');
    });

    it('chatwootLabel del preview propagado a la Campaign', async () => {
      const { useCase, previewRepo, campaignRepo } = await setup({ chatwootLabels: ['promo-agosto'] });
      const preview = await previewRepo.create(
        buildPreviewData({ chatwootLabel: 'promo-agosto', recipients: ONE_RECIPIENT }),
      );

      const result = await useCase.execute({ previewId: preview.id }, 'key-1');

      const campaign = await campaignRepo.findById(result.campaignId);
      expect(campaign?.chatwootLabel).toBe('promo-agosto');
    });
  });

  describe('D8 — orden markConsumed DESPUÉS de CreateCampaign', () => {
    it('markConsumed pierde la carrera (otro ganó el mismo previewId) → la Campaign recién creada se marca failed, responde 409', async () => {
      const { useCase, previewRepo, campaignRepo } = await setup();
      const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
      jest.spyOn(previewRepo, 'markConsumed').mockResolvedValueOnce(false);

      await expect(useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(PreviewAlreadyConsumedError);

      const list = await campaignRepo.list({});
      expect(list.total).toBe(1); // la Campaign SÍ se creó (antes del markConsumed)
      expect(list.data[0]!.status).toBe('failed');
      expect(list.data[0]!.error).toBe('preview consumido por otro request');
    });
  });

  describe('SEND-8 — runner ocupado', () => {
    it('runner ocupado en el PRIMER intento → 409 con campaignId + retryAfterSeconds; retry tras liberarse el lock reanuda la MISMA campaña', async () => {
      const { useCase, previewRepo, campaignRepo, campaignStarter } = await setup();
      const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
      campaignStarter.accepted = false;

      let firstCampaignId = '';
      try {
        await useCase.execute({ previewId: preview.id }, 'key-1');
        throw new Error('expected CampaignRunnerBusyError');
      } catch (err) {
        expect(err).toBeInstanceOf(CampaignRunnerBusyError);
        const busy = err as InstanceType<typeof CampaignRunnerBusyError>;
        expect(busy.retryAfterSeconds).toBe(60);
        expect(busy.campaignId).toBeTruthy();
        firstCampaignId = busy.campaignId;
      }

      const consumedPreview = await previewRepo.findById(preview.id);
      expect(consumedPreview?.consumedAt).not.toBeNull(); // preview quedó consumido igual (D8)
      expect((await campaignRepo.list({})).total).toBe(1); // UNA sola Campaign

      // libera el lock y reintenta con el MISMO key+preview.
      campaignStarter.accepted = true;
      const retry = await useCase.execute({ previewId: preview.id }, 'key-1');

      expect(retry.campaignId).toBe(firstCampaignId);
      expect(retry.resumed).toBe(true);
      expect((await campaignRepo.list({})).total).toBe(1); // NUNCA una segunda Campaign
    });
  });

  describe('SEND-9 — éxito', () => {
    it('flag ON, topes OK, runner libre → {campaignId, accepted:true, total}', async () => {
      const { useCase, previewRepo, campaignStarter } = await setup();
      const preview = await previewRepo.create(
        buildPreviewData({
          recipients: [
            { phoneE164: '+5491123456789', name: 'Ana', variables: { '1': 'Ana' } },
            { phoneE164: '+5491198765432', name: 'Beto', variables: { '1': 'Beto' } },
          ],
        }),
      );

      const result = await useCase.execute({ previewId: preview.id }, 'key-1');

      expect(result.accepted).toBe(true);
      expect(result.total).toBe(2);
      expect(result.resumed).toBeUndefined();
      expect(campaignStarter.calls).toEqual([result.campaignId]);
      const consumedPreview = await previewRepo.findById(preview.id);
      expect(consumedPreview?.campaignId).toBe(result.campaignId);
    });
  });

  /**
   * fix wave F1 (finding F10) — SEND-2 fija el orden: VENCIDO (410) ANTES que
   * CONSUMIDO (409). El codigo chequeaba `consumedAt` primero, asi que un
   * preview vencido Y consumido devolvia 409 (\"reintentalo con otro preview\")
   * cuando la verdad util es 410 (\"ese preview ya no existe para nadie\").
   */
  describe('fix wave F1 (F10) — orden de los chequeos del ciclo de vida del preview', () => {
    it('preview VENCIDO y ademas consumido → PREVIEW_EXPIRED (410), no PREVIEW_ALREADY_CONSUMED', async () => {
      const s = await setup();
      const preview = await s.previewRepo.create(
        buildPreviewData({ recipients: ONE_RECIPIENT, expiresAt: new Date(NOW.getTime() - 1000).toISOString() }),
      );
      await s.previewRepo.markConsumed(preview.id, 'some-other-campaign');

      await expect(s.useCase.execute({ previewId: preview.id }, 'key-nueva')).rejects.toThrow(PreviewExpiredError);
    });

    it('preview consumido pero VIGENTE → sigue siendo PREVIEW_ALREADY_CONSUMED (409)', async () => {
      const s = await setup();
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
      await s.previewRepo.markConsumed(preview.id, 'some-other-campaign');

      await expect(s.useCase.execute({ previewId: preview.id }, 'key-nueva')).rejects.toThrow(
        PreviewAlreadyConsumedError,
      );
    });
  });

  /**
   * fix wave F1 (finding F3) — el fast-path de GUARD-0 (`replay`) se salteaba
   * DOS cosas: (a) el kill-switch, que KS-1 no exime en ningun caso, y (b) el
   * estado de la campana — llamaba `campaignStarter.start()` a ciegas incluso
   * sobre una campana YA terminada, re-disparandola.
   */
  describe('fix wave F1 (F3) — replay: kill-switch fail-closed + estado de la campana', () => {
    /** Crea la campana via un primer send exitoso y devuelve su id + el previewId. */
    async function firstSend(s: Setup, key = 'key-1'): Promise<{ campaignId: string; previewId: string }> {
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
      const res = await s.useCase.execute({ previewId: preview.id }, key);
      return { campaignId: res.campaignId, previewId: preview.id };
    }

    it('(a) flag apagado DESPUES del send → el replay tambien responde FEATURE_DISABLED (KS-1 no tiene excepcion de replay)', async () => {
      const s = await setup();
      const { previewId } = await firstSend(s);
      s.campaignStarter.calls = [];
      s.featureFlags.seed(FLAG_KEY, false);

      await expect(s.useCase.execute({ previewId }, 'key-1')).rejects.toThrow(FeatureExternalBulkDisabledError);
      expect(s.campaignStarter.calls).toEqual([]); // ni siquiera intento arrancar
    });

    it('(b) campana `done` → 200 idempotente {resumed:false, status:"done"}, SIN re-arrancar el runner', async () => {
      const s = await setup();
      const { campaignId, previewId } = await firstSend(s);
      await s.campaignRepo.update(campaignId, { status: 'done' });
      s.campaignStarter.calls = [];

      const res = await s.useCase.execute({ previewId }, 'key-1');

      expect(res).toMatchObject({ campaignId, accepted: true, resumed: false, status: 'done' });
      expect(s.campaignStarter.calls).toEqual([]);
    });

    it('(b) campana `failed` → 200 idempotente {resumed:false, status:"failed"}, SIN re-arrancar el runner', async () => {
      const s = await setup();
      const { campaignId, previewId } = await firstSend(s);
      await s.campaignRepo.update(campaignId, { status: 'failed' });
      s.campaignStarter.calls = [];

      const res = await s.useCase.execute({ previewId }, 'key-1');

      expect(res).toMatchObject({ campaignId, resumed: false, status: 'failed' });
      expect(s.campaignStarter.calls).toEqual([]);
    });

    it('(b) campana `running` → resumed:true SIN llamar start (ya esta corriendo)', async () => {
      const s = await setup();
      const { campaignId, previewId } = await firstSend(s);
      await s.campaignRepo.update(campaignId, { status: 'running' });
      s.campaignStarter.calls = [];

      const res = await s.useCase.execute({ previewId }, 'key-1');

      expect(res).toMatchObject({ campaignId, resumed: true, status: 'running' });
      expect(s.campaignStarter.calls).toEqual([]);
    });

    it('(b) campana `pending` → SI arranca el runner (resume real, SEND-8)', async () => {
      const s = await setup();
      const { campaignId, previewId } = await firstSend(s);
      expect((await s.campaignRepo.findById(campaignId))?.status).toBe('pending');
      s.campaignStarter.calls = [];

      const res = await s.useCase.execute({ previewId }, 'key-1');

      expect(res).toMatchObject({ campaignId, resumed: true, status: 'pending' });
      expect(s.campaignStarter.calls).toEqual([campaignId]);
    });

    it('(b) campana `pending` con el runner ocupado → sigue siendo 409 CAMPAIGN_RUNNER_BUSY', async () => {
      const s = await setup();
      const { previewId } = await firstSend(s);
      s.campaignStarter.accepted = false;

      await expect(s.useCase.execute({ previewId }, 'key-1')).rejects.toThrow(CampaignRunnerBusyError);
    });
  });

  /**
   * fix wave F1 (finding F2) — el cupo diario contaba `status:'sent'`, que va
   * SIEMPRE por detras del trabajo ya AUTORIZADO: entre el `send` que crea la
   * campana y el runner que efectivamente envia, `countSent...` devuelve ~0 y
   * el cap deja pasar lote tras lote. Traza K1/K2/K3 (cap diario = 2, lotes de
   * 1): con el bug los TRES pasan (3 autorizados > cap 2); con el fix el
   * tercero rebota con CAP_EXCEEDED. La cuenta pasa a ser "recipients CREADOS
   * hoy para campanas del creador externo, con status NOT IN (skipped,
   * opted_out)" — cada intento autorizado quema cupo en el instante en que se
   * crea la campana, no cuando el mensaje sale.
   */
  describe('fix wave F1 (F2) — el cupo diario cuenta lo AUTORIZADO, no lo ya enviado', () => {
    async function sendOne(
      s: Setup,
      phone: string,
      key: string,
    ): Promise<{ campaignId: string } | Error> {
      const preview = await s.previewRepo.create(
        buildPreviewData({ recipients: [{ phoneE164: phone, name: 'X', variables: { '1': 'X' } }] }),
      );
      try {
        return await s.useCase.execute({ previewId: preview.id }, key);
      } catch (err) {
        return err as Error;
      }
    }

    it('K1/K2/K3 con maxPerDay=2 y lotes de 1: el TERCER send rebota con CAP_EXCEEDED aunque nada se haya enviado todavia', async () => {
      const s = await setup();
      await s.configRepo.set({ maxPerRequest: 500, maxPerDay: 2 });

      const k1 = await sendOne(s, '+5491123456701', 'K1');
      const k2 = await sendOne(s, '+5491123456702', 'K2');
      const k3 = await sendOne(s, '+5491123456703', 'K3');

      expect(k1).not.toBeInstanceOf(Error);
      expect(k2).not.toBeInstanceOf(Error);
      // Ningun recipient llego a `sent` (el runner es un fake que no envia nada):
      // el cap NO puede apoyarse en `sent` o esto pasa para siempre.
      expect(k3).toBeInstanceOf(CapExceededError);
      expect((k3 as CapExceededError).limit).toBe('perDay');
      expect((await s.campaignRepo.list({})).total).toBe(2); // K3 no creo campana
    });

    it('un recipient `delivered` sigue contando contra el cupo (no desaparece al avanzar de estado)', async () => {
      const s = await setup();
      await s.configRepo.set({ maxPerRequest: 500, maxPerDay: 1 });
      const first = await sendOne(s, '+5491123456711', 'K1');
      expect(first).not.toBeInstanceOf(Error);
      const [r] = (await s.campaignRepo.listRecipients((first as { campaignId: string }).campaignId)).data;
      await s.campaignRepo.updateRecipient(r!.id, { status: 'delivered' });

      const second = await sendOne(s, '+5491123456712', 'K2');

      expect(second).toBeInstanceOf(CapExceededError);
    });

    it('un recipient `skipped`/`opted_out` NO quema cupo (nunca se le autorizo un mensaje)', async () => {
      const s = await setup();
      await s.configRepo.set({ maxPerRequest: 500, maxPerDay: 1 });
      const first = await sendOne(s, '+5491123456721', 'K1');
      const [r] = (await s.campaignRepo.listRecipients((first as { campaignId: string }).campaignId)).data;
      await s.campaignRepo.updateRecipient(r!.id, { status: 'opted_out' });

      const second = await sendOne(s, '+5491123456722', 'K2');

      expect(second).not.toBeInstanceOf(Error);
    });
  });

  /**
   * fix wave F1 (findings F5, F9, F12, F13) — el resto de la ola sobre el
   * camino de `send`.
   */
  describe('fix wave F1 — send: backstop de carrera, allowlist, variables y destino', () => {
    /** (F9) El input que `SendExternalBulk` le arma a `CreateCampaign`. */
    it('F9 — el input a CreateCampaign lleva SOLO manualContacts + un allowlist EXPLICITO (nunca undefined)', async () => {
      const s = await setup();
      const spy = jest.spyOn(
        (s.useCase as unknown as { createCampaign: CreateCampaign }).createCampaign,
        'execute',
      );
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      await s.useCase.execute({ previewId: preview.id }, 'key-1');

      const input = spy.mock.calls[0]![0] as unknown as Record<string, unknown>;
      // Estructural: la ruta externa NO puede expresar destinatarios que no sean
      // numeros sueltos — ni segmento con criterio, ni ids de clientes, ni tareas.
      expect(input['manualContacts']).toHaveLength(1);
      expect(input['manualClientIds']).toBeUndefined();
      expect(input['taskStageIds']).toBeUndefined();
      expect(input['segment']).toEqual({ statuses: [] });
      // El gate de `forbiddenBulkTargets` CORRE (antes llegaba `undefined` = sin enforcement).
      expect(input['allowedBulkActions']).toBeDefined();
      const allowed = new Set(input['allowedBulkActions'] as string[]);
      expect(allowed.has(BULK_NUMBERS_ACTION)).toBe(true);
      expect(allowed.has('*')).toBe(false); // jamas el sentinel de super_admin
    });

    it('F9 — un estado de cliente DESCONOCIDO (no mapeado en BULK_STATUS_ACTION) bloquea la campana en vez de enviarla', async () => {
      // El E.164 del preview (+5491123456789) normaliza a `1123456789`: este Client vincula EXACTO.
      const raro = makeCandidate({ clientId: 'c-raro', phone: '+54 9 11 2345-6789', status: 'estado_futuro_sin_permiso' });
      const s = await setup({ clients: [raro] });
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(
        BulkRecipientsNotPermittedError,
      );
    });

    it('F12 — una variable NO declarada que quedo en el preview no llega a CampaignRecipient.variables', async () => {
      const s = await setup();
      const preview = await s.previewRepo.create(
        buildPreviewData({
          recipients: [{ phoneE164: '+5491123456789', name: 'Ana', variables: { '1': 'Ana', '99': 'basura' } }],
        }),
      );

      const res = await s.useCase.execute({ previewId: preview.id }, 'key-1');

      const recipients = await s.campaignRepo.listRecipients(res.campaignId);
      expect(recipients.data[0]!.variables).toEqual({ '1': 'Ana' });
    });

    it('F13 — el destino persistido es el E.164 del preview, aunque el numero vincule a un Client', async () => {
      // Mismo numero, otro formato guardado en el Client (match EXACTO por normalizePhone).
      const client = makeCandidate({ clientId: 'c1', name: 'Juan Cliente', phone: '+54 11 15-2345-6789' });
      const s = await setup({ clients: [client] });
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      const res = await s.useCase.execute({ previewId: preview.id }, 'key-1');

      const recipients = await s.campaignRepo.listRecipients(res.campaignId);
      expect(recipients.data).toHaveLength(1);
      expect(recipients.data[0]!.phoneE164).toBe('+5491123456789');
    });

    it('F5 — dos `send` concurrentes con la MISMA key: el perdedor (violacion de unique REAL del InMemory) recibe la campana GANADORA, no un 500', async () => {
      const s = await setup();
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      // Simula la carrera: AMBOS pasaron el guard-0 (findByExternalIdempotencyKey
      // devolvio null) — la campana ganadora YA existe en el repo (el otro
      // request le gano la carrera), pero ESTE request todavia no la vio.
      const winner = await s.campaignRepo.create({
        name: 'ganadora',
        templateRef: TEMPLATE.contentSid,
        segment: { statuses: [] },
        variableSpec: {},
        total: 1,
        createdById: s.apiMessagingUserId,
        externalIdempotencyKey: 'key-race',
      });
      // El guard-0 falla UNA vez (el ganador todavia no estaba cuando este
      // request lo miro) y recien el `create` REAL choca contra el
      // `@@unique([externalIdempotencyKey])` que ahora hace cumplir el
      // InMemory (fix wave F2, NEW-1) — la carrera REAL, sin espiar `create`
      // ni pre-construir el error a mano.
      const realLookup = s.campaignRepo.findByExternalIdempotencyKey.bind(s.campaignRepo);
      jest
        .spyOn(s.campaignRepo, 'findByExternalIdempotencyKey')
        .mockImplementationOnce(async () => null)
        .mockImplementation(realLookup);

      const res = await s.useCase.execute({ previewId: preview.id }, 'key-race');

      expect(res.campaignId).toBe(winner.id);
      expect(res.accepted).toBe(true);
    });

    it('fix wave F2 (NEW-1) — un UniqueConstraintViolationError de OTRO field (no externalIdempotencyKey) NO se confunde con la carrera de idempotencia: sube tal cual', async () => {
      const s = await setup();
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
      const boom = new UniqueConstraintViolationError('Campaign', 'someOtherField');
      jest.spyOn(s.campaignRepo, 'create').mockRejectedValueOnce(boom);

      await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toBe(boom);
    });
  });

  describe('SEND-10 / task 3.7 — variableSpec baseline no dispara CAMP-3', () => {
    it("una key SOLO aportada por recipients (ausente en el global) → variableSpec la cubre con '' de baseline, el mensaje real usa el valor del recipient", async () => {
      const TEMPLATE_2VARS: TemplateDto = { ...TEMPLATE, variables: { '1': 'Nombre', '2': 'Extra' } };
      const { useCase, previewRepo, campaignRepo } = await setup({ templates: [TEMPLATE_2VARS] });
      const preview = await previewRepo.create(
        buildPreviewData({
          templateRef: TEMPLATE_2VARS.contentSid,
          variables: { '1': 'GlobalUno' }, // NO trae '2' — solo la trae el merge por-recipient
          recipients: [{ phoneE164: '+5491123456789', name: 'Ana', variables: { '1': 'Ana', '2': 'ValorRecipient' } }],
        }),
      );

      const result = await useCase.execute({ previewId: preview.id }, 'key-1');

      const campaign = await campaignRepo.findById(result.campaignId);
      expect(campaign?.variableSpec).toEqual({
        '1': { source: 'literal', value: 'GlobalUno' },
        '2': { source: 'literal', value: '' }, // baseline auditable, NUNCA llega al mensaje real
      });
      const recipients = await campaignRepo.listRecipients(result.campaignId);
      expect(recipients.data[0]!.variables).toEqual({ '1': 'Ana', '2': 'ValorRecipient' });
    });
  });

  /**
   * twilio-credit-guard (Batch 3, task 3.1/3.2, design.md D4.c) — gate
   * fail-closed de crédito, ANTES de `CreateCampaign`/`markConsumed`, DESPUÉS
   * de la re-validación completa de SEND-4 (template/label/caps). Molde de
   * setup: `TEMPLATE.category` está ausente (D2 fixture) ⇒ se tarifa
   * MARKETING (`0.0618 + 0.0050 = 0.0668` con los defaults).
   */
  describe('CG-SEND-2 — crédito insuficiente al momento del send', () => {
    it('saldo insuficiente ⇒ InsufficientCreditError (422), CERO Campaign creada, preview sigue consumedAt:null', async () => {
      const s = await setup({ creditAmount: '0.0010' });
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(InsufficientCreditError);

      expect((await s.campaignRepo.list({})).total).toBe(0);
      expect((await s.previewRepo.findById(preview.id))?.consumedAt).toBeNull();
    });

    it('el error trae {available, estimatedCost, currency} — D5.b los necesita para el 422 de la ruta', async () => {
      const s = await setup({ creditAmount: '0.0010' });
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      try {
        await s.useCase.execute({ previewId: preview.id }, 'key-1');
        throw new Error('expected InsufficientCreditError');
      } catch (err) {
        expect(err).toBeInstanceOf(InsufficientCreditError);
        const e = err as InstanceType<typeof InsufficientCreditError>;
        expect(e.available).toBe('0.0010');
        expect(e.estimatedCost).toBe('0.0668');
        expect(e.currency).toBe('USD');
      }
    });
  });

  describe('CG-SEND-3 — balance inalcanzable o mismatch de moneda ⇒ fail-closed', () => {
    it('Balance.json inalcanzable (creditPort.getBalance() lanza) ⇒ CreditUnavailableError (503), CERO Campaign', async () => {
      const s = await setup({ creditFails: true });
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(CreditUnavailableError);

      expect((await s.campaignRepo.list({})).total).toBe(0);
      expect((await s.previewRepo.findById(preview.id))?.consumedAt).toBeNull();
    });

    it('moneda del balance (ARS) ≠ la de MessagingRatesConfig (USD) ⇒ CreditUnavailableError (503), CERO Campaign', async () => {
      const s = await setup({ creditCurrency: 'ARS' });
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(CreditUnavailableError);

      expect((await s.campaignRepo.list({})).total).toBe(0);
    });
  });

  describe('CG-SEND-4 — el replay NO re-chequea crédito', () => {
    it('replay (misma Idempotency-Key, campaña ya creada) ⇒ creditPort.calls NO aumenta (no vuelve a leer el balance)', async () => {
      const s = await setup();
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      await s.useCase.execute({ previewId: preview.id }, 'key-1');
      const callsAfterFirstSend = s.creditPort.calls;
      expect(callsAfterFirstSend).toBeGreaterThan(0); // el send FRESCO SÍ chequeó crédito

      const replay = await s.useCase.execute({ previewId: preview.id }, 'key-1');

      expect(replay.resumed).toBe(true);
      expect(s.creditPort.calls).toBe(callsAfterFirstSend); // el replay NO volvió a llamar getBalance()
    });
  });

  describe('CG-SEND-5 — tarifas en cero ⇒ guard inerte', () => {
    it('las 4 tarifas en 0 ⇒ estimatedCost=0.0000, el guard NUNCA rechaza aunque el saldo también sea 0', async () => {
      const s = await setup({
        creditAmount: '0.0000',
        ratesPatch: { currency: 'USD', utilityRate: '0', marketingRate: '0', authenticationRate: '0', providerFee: '0' },
      });
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      const result = await s.useCase.execute({ previewId: preview.id }, 'key-1');

      expect(result.accepted).toBe(true);
      expect((await s.campaignRepo.list({})).total).toBe(1);
    });
  });

  describe('D0 — regla de oro del orden: crédito SIEMPRE después de caps/template, nunca antes', () => {
    it('cap excedido (perDay) Y saldo insuficiente ⇒ CAP_EXCEEDED, el crédito NUNCA corre (creditPort.calls===0)', async () => {
      const s = await setup({ creditAmount: '0.0000' });
      await s.configRepo.set({ maxPerRequest: 500, maxPerDay: 0 });
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(CapExceededError);

      expect(s.creditPort.calls).toBe(0);
    });

    it('template no aprobado Y saldo insuficiente ⇒ TEMPLATE_NOT_APPROVED, el crédito NUNCA corre (creditPort.calls===0)', async () => {
      const s = await setup({ creditAmount: '0.0000' });
      const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
      jest.spyOn(s.templatePort, 'listTemplates').mockResolvedValue([{ ...TEMPLATE, approvalStatus: 'pending' }]);

      await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(TemplateNotApprovedError);

      expect(s.creditPort.calls).toBe(0);
    });
  });
});

/** fix wave F1 (F5) — N destinatarios DISTINTOS, para que `estimatedCost != unitCost`. */
function nRecipients(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    phoneE164: `+54911${20000000 + i}`,
    name: `Cliente ${i}`,
    variables: { '1': `Cliente ${i}` },
  }));
}

/**
 * fix wave F1 (F1) — CACHE RANCIA. El flujo NORMAL de 2 pasos es
 * `validate` (que llena la cache de 60s del port) → `send` segundos después.
 * El gate del send comparaba contra el saldo PRE-gasto servido por esa cache:
 * un lote de 5000 USD podía pasar con saldo 0 real.
 */
describe('CG-SEND-2 (fix wave F1, F1) — el gate lee saldo FRESCO, nunca el de la cache del validate', () => {
  it('validate llena la cache con 10.0000, el saldo REAL cae a 0.0000, el send a los 30s ⇒ 422 InsufficientCreditError', async () => {
    let clockMs = NOW.getTime();
    const s = await setup({ creditAmount: '10.0000', creditNow: () => clockMs });
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

    // Paso 1 (validate): la MISMA instancia del port lee el balance y llena el slot.
    const primed = await s.creditPort.getBalance();
    expect(primed.amount).toBe('10.0000');
    expect(s.creditPort.fetches).toBe(1);

    // El saldo real se drena por fuera (otra campaña, un cobro de Twilio).
    s.creditPort.amount = '0.0000';
    clockMs += 30_000; // TTL de 60s TODAVÍA vigente

    await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(InsufficientCreditError);

    expect(s.creditPort.fetches).toBe(2); // el gate FUE al origen, no a la cache
    expect((await s.campaignRepo.list({})).total).toBe(0);
    expect((await s.previewRepo.findById(preview.id))?.consumedAt).toBeNull();
  });

  it('el gate pide fresh: aunque la cache tenga 0.0000, un saldo REAL suficiente deja pasar el envío', async () => {
    let clockMs = NOW.getTime();
    const s = await setup({ creditAmount: '0.0000', creditNow: () => clockMs });
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

    await s.creditPort.getBalance(); // cache con 0.0000
    s.creditPort.amount = '10.0000';
    clockMs += 30_000;

    const result = await s.useCase.execute({ previewId: preview.id }, 'key-1');

    expect(result.accepted).toBe(true);
  });

  it('tras un send ACEPTADO la cache queda INVALIDADA — la próxima lectura normal vuelve al origen', async () => {
    let clockMs = NOW.getTime();
    const s = await setup({ creditAmount: '10000.0000', creditNow: () => clockMs });
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

    await s.useCase.execute({ previewId: preview.id }, 'key-1');
    const fetchesAfterSend = s.creditPort.fetches;

    clockMs += 1_000; // el TTL seguiría vigente si el slot no se hubiera vaciado
    await s.creditPort.getBalance(); // lo que haría el siguiente `validate`

    expect(s.creditPort.fetches).toBe(fetchesAfterSend + 1);
  });

  it('un send RECHAZADO por saldo NO invalida de más: el slot sigue sirviendo su valor', async () => {
    let clockMs = NOW.getTime();
    const s = await setup({ creditAmount: '0.0010', creditNow: () => clockMs });
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

    await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(InsufficientCreditError);
    const fetchesAfterReject = s.creditPort.fetches;
    const cached = await s.creditPort.getBalance();

    expect(cached.cached).toBe(true);
    expect(s.creditPort.fetches).toBe(fetchesAfterReject);
  });
});

/**
 * fix wave F1 (F3) — SOBREGIRO por concurrencia. Dos `send` simultáneos leían
 * el MISMO saldo y ambos pasaban el gate: 2 × 8 = 16 USD gastados con 10 de
 * saldo. El tramo gate + CreateCampaign + markConsumed se serializa con un
 * mutex en proceso (protección de instancia única; el runner ya es uno por
 * proceso).
 */
describe('CG-SEND-2 (fix wave F1, F3) — dos sends concurrentes NO sobregiran', () => {
  const RATES_4_USD = {
    currency: 'USD',
    utilityRate: '4.0000',
    marketingRate: '4.0000',
    authenticationRate: '4.0000',
    providerFee: '0.0000',
  };

  it('saldo 10, dos lotes de 8 cada uno lanzados a la vez ⇒ EXACTAMENTE un 202 y un 422', async () => {
    const s = await setup({ creditAmount: '10.0000', ratesPatch: RATES_4_USD });
    // El envío aceptado compromete la plata: el saldo REAL cae a 2.
    s.campaignStarter.onStart = () => {
      s.creditPort.amount = '2.0000';
    };
    const two = nRecipients(2);
    const previewA = await s.previewRepo.create(buildPreviewData({ recipients: two }));
    const previewB = await s.previewRepo.create(buildPreviewData({ recipients: two }));

    const results = await Promise.allSettled([
      s.useCase.execute({ previewId: previewA.id }, 'key-A'),
      s.useCase.execute({ previewId: previewB.id }, 'key-B'),
    ]);

    const accepted = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCreditError);
    expect((await s.campaignRepo.list({})).total).toBe(1);
  });

  it('sin drenaje, dos sends concurrentes con saldo de sobra SIGUEN pasando los dos (el mutex serializa, no bloquea)', async () => {
    const s = await setup({ creditAmount: '10000.0000' });
    const previewA = await s.previewRepo.create(buildPreviewData({ recipients: nRecipients(2) }));
    const previewB = await s.previewRepo.create(buildPreviewData({ recipients: nRecipients(3) }));

    const [a, b] = await Promise.all([
      s.useCase.execute({ previewId: previewA.id }, 'key-A'),
      s.useCase.execute({ previewId: previewB.id }, 'key-B'),
    ]);

    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(true);
    expect((await s.campaignRepo.list({})).total).toBe(2);
  });
});

/**
 * fix wave F1 (F5) — FIXTURES DEGENERADOS. Todos los tests del gate usaban UN
 * destinatario, con lo cual `estimatedCost === unitCost` y la multiplicación
 * por `preview.recipients.length` nunca se ejercitaba: reemplazarla por `1`
 * dejaba la suite VERDE.
 */
describe('CG-SEND-2 (fix wave F1, F5) — estimatedCost = N × unitCost, con N > 1', () => {
  it('3 destinatarios, MARKETING con defaults ⇒ estimatedCost 0.2004 (3 × 0.0668)', async () => {
    const s = await setup({ creditAmount: '0.2003' }); // un decimal POR DEBAJO del costo de 3
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: nRecipients(3) }));

    try {
      await s.useCase.execute({ previewId: preview.id }, 'key-1');
      throw new Error('expected InsufficientCreditError');
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientCreditError);
      expect((err as InstanceType<typeof InsufficientCreditError>).estimatedCost).toBe('0.2004');
    }
  });

  it('500 destinatarios ⇒ estimatedCost 33.4000 EXACTO (500 × 0.0668)', async () => {
    const s = await setup({ creditAmount: '33.3999' });
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: nRecipients(500) }));

    try {
      await s.useCase.execute({ previewId: preview.id }, 'key-1');
      throw new Error('expected InsufficientCreditError');
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientCreditError);
      expect((err as InstanceType<typeof InsufficientCreditError>).estimatedCost).toBe('33.4000');
    }
  });

  it('el borde manda: saldo EXACTAMENTE 33.4000 con 500 destinatarios ⇒ pasa', async () => {
    const s = await setup({ creditAmount: '33.4000' });
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: nRecipients(500) }));

    const result = await s.useCase.execute({ previewId: preview.id }, 'key-1');

    expect(result.accepted).toBe(true);
    expect(result.total).toBe(500);
  });
});

/**
 * fix wave F1 (F4) — `ratesRepo.get()` vivía FUERA del try/catch del gate: un
 * repo caído subía el error crudo como 500, cuando el contrato fail-closed
 * dice 503 CREDIT_UNAVAILABLE.
 */
describe('CG-SEND-3 (fix wave F1, F4) — cualquier degradación DENTRO del gate cierra con 503', () => {
  it('ratesRepo.get() lanza ⇒ CreditUnavailableError (503), no un 500 crudo, CERO Campaign', async () => {
    const s = await setup();
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
    jest.spyOn(s.ratesRepo, 'get').mockRejectedValue(new Error('db down'));

    await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toBeInstanceOf(CreditUnavailableError);

    expect((await s.campaignRepo.list({})).total).toBe(0);
    expect((await s.previewRepo.findById(preview.id))?.consumedAt).toBeNull();
  });

  it('tarifa ilegible en la fila ⇒ CreditUnavailableError (503), NUNCA tratada como 0', async () => {
    const s = await setup({
      creditAmount: '10000.0000',
      ratesPatch: {
        currency: 'USD',
        utilityRate: '0.0120',
        marketingRate: 'not-a-number',
        authenticationRate: '0.0220',
        providerFee: '0.0050',
      },
    });
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

    await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toBeInstanceOf(CreditUnavailableError);

    expect((await s.campaignRepo.list({})).total).toBe(0);
  });

  it('overflow de punto fijo (tarifa monstruosa) ⇒ CreditUnavailableError (503), jamás un 500', async () => {
    const s = await setup({
      creditAmount: '10000.0000',
      ratesPatch: {
        currency: 'USD',
        utilityRate: '0.0120',
        marketingRate: '900000000000.0000',
        authenticationRate: '0.0220',
        providerFee: '0.0000',
      },
    });
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: nRecipients(2) }));

    await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toBeInstanceOf(CreditUnavailableError);

    expect((await s.campaignRepo.list({})).total).toBe(0);
  });
});

/**
 * fix wave F1 (F7) — perilla PROPIA del guard. Apagarla es fail-OPEN por
 * decisión EXPLÍCITA del operador: el envío sigue, sin gate de crédito.
 */
describe('CG-FLAG (fix wave F1, F7) — messaging-credit-guard-enabled', () => {
  const GUARD_FLAG_KEY = 'messaging-credit-guard-enabled';

  it('flag OFF ⇒ el gate SE SALTEA: saldo 0 y el envío igual se acepta, sin tocar el proveedor', async () => {
    const s = await setup({ creditAmount: '0.0000' });
    s.featureFlags.seed(GUARD_FLAG_KEY, false);
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

    const result = await s.useCase.execute({ previewId: preview.id }, 'key-1');

    expect(result.accepted).toBe(true);
    expect(s.creditPort.calls).toBe(0);
  });

  it('flag ON explícito ⇒ el gate corre y rechaza por saldo', async () => {
    const s = await setup({ creditAmount: '0.0000' });
    s.featureFlags.seed(GUARD_FLAG_KEY, true);
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

    await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(InsufficientCreditError);
  });

  it('la fila del flag NO existe ⇒ guard PRENDIDO (fail-closed, al revés que el kill-switch)', async () => {
    const s = await setup({ creditAmount: '0.0000' });
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

    await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(InsufficientCreditError);
  });

  it('el repo de flags REVIENTA para ESA key ⇒ guard PRENDIDO (un repo caído no apaga una protección)', async () => {
    const s = await setup({ creditAmount: '0.0000' });
    const realGet = s.featureFlags.get.bind(s.featureFlags);
    jest.spyOn(s.featureFlags, 'get').mockImplementation(async (key: string) => {
      if (key === GUARD_FLAG_KEY) throw new Error('db down');
      return realGet(key);
    });
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

    await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(InsufficientCreditError);
  });

  it('el kill-switch general SIGUE mandando: guard OFF pero API externa OFF ⇒ FeatureExternalBulkDisabledError', async () => {
    const s = await setup({ flagEnabled: false });
    s.featureFlags.seed(GUARD_FLAG_KEY, false);
    const preview = await s.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

    await expect(s.useCase.execute({ previewId: preview.id }, 'key-1')).rejects.toThrow(FeatureExternalBulkDisabledError);
  });
});
