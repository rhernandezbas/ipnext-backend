/**
 * external-bulk-messaging (Batch 2, tasks 2.1-2.6) — `ValidateExternalBulk`.
 * Matriz spec↔test: cada `describe` mapea a UN requirement (VAL-1..VAL-10,
 * KS-1) de `openspec/changes/external-bulk-messaging/specs/external-bulk-messaging/spec.md`.
 *
 * Adapters SIEMPRE in-memory (regla del repo): `InMemoryExternalBulkPreviewRepository`,
 * `InMemoryExternalBulkMessagingConfigRepository`, `InMemoryCampaignRepository`,
 * `InMemoryTemplateMessagingGateway`, `InMemoryFeatureFlagRepository`,
 * `InMemoryRbacUserRepository`, `FakeChatwootGateway` (helper compartido). JAMÁS
 * se mockea Prisma ni el use case bajo test.
 */
import { ValidateExternalBulk } from '@application/use-cases/messaging/ValidateExternalBulk';
import { InMemoryExternalBulkPreviewRepository } from '@infrastructure/adapters/in-memory/InMemoryExternalBulkPreviewRepository';
import { InMemoryExternalBulkMessagingConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryExternalBulkMessagingConfigRepository';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { bootstrapApiMessagingUser } from '@infrastructure/bootstrap/bootstrapApiMessagingUser';
import { InMemoryCreditBalancePort } from '@infrastructure/adapters/in-memory/InMemoryCreditBalancePort';
import { InMemoryMessagingRatesConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryMessagingRatesConfigRepository';
import { FakeChatwootGateway } from '../../helpers/FakeChatwootGateway';
import type {
  CampaignSegmentSource,
  CampaignRecipientCandidate,
  CampaignSegmentFilter,
} from '@domain/ports/CustomerRepository';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';
import type { ValidateExternalBulkInput } from '@application/dto/external-bulk-messaging.dto';
import {
  FeatureExternalBulkDisabledError,
  ExternalBulkValidationError,
  CapExceededError,
  EmptyRecipientsError,
  ChatwootLabelNotFoundError,
  ReporterUnavailableError,
} from '@domain/errors/external-bulk-messaging';
import { TemplateNotApprovedError } from '@domain/errors/messaging-bulk';
import { ChatwootUnavailableError } from '@domain/errors/messaging';

const NOW = new Date('2026-09-02T12:00:00.000Z');
import { MAX_MANUAL_CONTACTS } from '@application/use-cases/messaging/resolveCombinedRecipients';

const FLAG_KEY = 'messaging-external-bulk-enabled';

const TEMPLATE: TemplateDto = {
  contentSid: 'HXpromo1',
  friendlyName: 'promo_setiembre',
  language: 'es',
  variables: { '1': 'Nombre' },
  approvalStatus: 'approved',
  body: 'Hola {{1}}',
};

// Dos representaciones DISTINTAS del MISMO E.164 (+5491123456789) — molde del
// comentario de `toWhatsAppE164.ts` ("011 15-2345-6789" → "+5491123456789").
const MOBILE_A = '011 15-2345-6789';
const MOBILE_A_ALT_FORMAT = '11 15-2345-6789';
const MOBILE_B = '011 15-9876-5432';

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
  return {
    listSegmentRecipients: async (_segment: CampaignSegmentFilter) => universe,
  };
}

interface Setup {
  useCase: ValidateExternalBulk;
  previewRepo: InMemoryExternalBulkPreviewRepository;
  configRepo: InMemoryExternalBulkMessagingConfigRepository;
  campaignRepo: InMemoryCampaignRepository;
  templatePort: InMemoryTemplateMessagingGateway;
  chatwootGateway: FakeChatwootGateway;
  featureFlags: InMemoryFeatureFlagRepository;
  rbacUserRepo: InMemoryRbacUserRepository;
  apiMessagingUserId: string;
  creditPort: InMemoryCreditBalancePort;
  ratesRepo: InMemoryMessagingRatesConfigRepository;
}

async function setup(
  opts: {
    templates?: TemplateDto[];
    clients?: CampaignRecipientCandidate[];
    flagEnabled?: boolean;
    bootstrapApiMessaging?: boolean;
  } = {},
): Promise<Setup> {
  const previewRepo = new InMemoryExternalBulkPreviewRepository({ now: () => NOW });
  const configRepo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
  const campaignRepo = new InMemoryCampaignRepository({ now: () => NOW });
  const templatePort = new InMemoryTemplateMessagingGateway({ templates: opts.templates ?? [TEMPLATE] });
  const chatwootGateway = new FakeChatwootGateway();
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
  const creditPort = new InMemoryCreditBalancePort();
  const ratesRepo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });

  const useCase = new ValidateExternalBulk(
    previewRepo,
    configRepo,
    campaignRepo,
    templatePort,
    makeSegmentSource(opts.clients ?? []),
    chatwootGateway,
    featureFlags,
    rbacUserRepo,
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
    apiMessagingUserId,
    creditPort,
    ratesRepo,
  };
}

function baseInput(overrides: Partial<ValidateExternalBulkInput> = {}): ValidateExternalBulkInput {
  return {
    templateRef: TEMPLATE.contentSid,
    variables: { '1': 'Cliente' },
    recipients: [{ phone: MOBILE_A }],
    ...overrides,
  };
}

describe('ValidateExternalBulk', () => {
  describe('KS-1 — kill-switch de acceso', () => {
    it('flag OFF → FeatureExternalBulkDisabledError (403), CERO llamadas downstream', async () => {
      const { useCase, templatePort, chatwootGateway } = await setup({ flagEnabled: false });
      const listTemplatesSpy = jest.spyOn(templatePort, 'listTemplates');
      const listLabelsSpy = jest.spyOn(chatwootGateway, 'listAccountLabels');

      await expect(useCase.execute(baseInput())).rejects.toThrow(FeatureExternalBulkDisabledError);

      expect(listTemplatesSpy).not.toHaveBeenCalled();
      expect(listLabelsSpy).not.toHaveBeenCalled();
    });

    it('repo de flags lanza → fail-safe a OFF (403), NUNCA interpretado como ON', async () => {
      const { useCase, featureFlags } = await setup();
      jest.spyOn(featureFlags, 'get').mockRejectedValue(new Error('db down'));

      await expect(useCase.execute(baseInput())).rejects.toThrow(FeatureExternalBulkDisabledError);
    });
  });

  describe('VAL-1 — forma del input', () => {
    it('recipients vacío → 400 VALIDATION_ERROR, sin persistir preview', async () => {
      const { useCase, previewRepo } = await setup();
      const createSpy = jest.spyOn(previewRepo, 'create');

      await expect(useCase.execute(baseInput({ recipients: [] }))).rejects.toThrow(ExternalBulkValidationError);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('recipients no-array → 400 VALIDATION_ERROR', async () => {
      const { useCase } = await setup();
      const bad = { ...baseInput(), recipients: 'nope' } as unknown as ValidateExternalBulkInput;

      await expect(useCase.execute(bad)).rejects.toThrow(ExternalBulkValidationError);
    });

    it('falta templateRef Y templateName → 400 VALIDATION_ERROR', async () => {
      const { useCase } = await setup();

      await expect(
        useCase.execute(baseInput({ templateRef: undefined, templateName: undefined })),
      ).rejects.toThrow(ExternalBulkValidationError);
    });
  });

  describe('VAL-2 — normalización E.164 AR móvil + razones de invalidez', () => {
    it('teléfono no normalizable → invalid con reason telefono_invalido', async () => {
      const { useCase } = await setup();

      const result = await useCase.execute(baseInput({ recipients: [{ phone: MOBILE_A }, { phone: '123' }] }));

      expect(result.invalid).toContainEqual({ input: '123', reason: 'telefono_invalido' });
    });

    // fix wave F3 (S1) — un NSN limpio de 10 dígitos ES la forma CANÓNICA del
    // móvil AR (el "9"/"15" son artefactos de discado): antes se descartaba
    // como `non_mobile`, pero el motor de envío (`toWhatsAppE164`) SIEMPRE lo
    // trató como móvil (`+549<nsn>`) — validate rechazaba lo que send hubiera
    // aceptado. Ya NO es `non_mobile`, es `mobile` (ver describe dedicado F3
    // más abajo para la matriz completa).
    it('NSN limpio de 10 dígitos, sin marcador ("9"/"15") → ahora es MÓVIL válido, no ya non_mobile', async () => {
      const { useCase } = await setup();

      // Compañero MOBILE_B (no MOBILE_A): MOBILE_A ("011 15-2345-6789") YA
      // reconstruye al MISMO E.164 que "1123456789" (mismo NSN "1123456789"
      // con y sin "15" embebido) — juntarlos daría `duplicado`, no probaría
      // la clasificación en sí.
      const result = await useCase.execute(
        baseInput({ recipients: [{ phone: MOBILE_B }, { phone: '1123456789' }] }),
      );

      expect(result.valid.map((v) => v.phone)).toEqual(
        expect.arrayContaining(['+5491198765432', '+5491123456789']),
      );
      expect(result.invalid).not.toContainEqual(expect.objectContaining({ input: '1123456789' }));
    });

    it('duplicado dentro del batch (mismo E.164, formato distinto) → el 2do cae invalid con reason duplicado', async () => {
      const { useCase } = await setup();

      const result = await useCase.execute(
        baseInput({ recipients: [{ phone: MOBILE_A }, { phone: MOBILE_A_ALT_FORMAT }] }),
      );

      expect(result.valid).toHaveLength(1);
      expect(result.invalid).toEqual([{ input: MOBILE_A_ALT_FORMAT, reason: 'duplicado' }]);
    });

    it('opt-out por MATCH EXACTO (Client vinculado con whatsappOptOutAt) → invalid opt_out', async () => {
      const { useCase } = await setup({
        clients: [makeCandidate({ clientId: 'c1', phone: '3364111111', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' })],
      });

      const result = await useCase.execute(
        baseInput({ recipients: [{ phone: MOBILE_A }, { phone: '3364111111' }] }),
      );

      expect(result.invalid).toContainEqual({ input: '3364111111', reason: 'opt_out' });
    });

    it('opt-out por SUFIJO (crudo con "15" embebido, SIN match exacto) → invalid opt_out', async () => {
      const { useCase } = await setup({
        clients: [makeCandidate({ clientId: 'c1', phone: '3364123456', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' })],
      });

      // '336415123456' normaliza distinto de '3364123456' (D3 gap documentado:
      // normalizePhone no quita el "15" embebido) — pero comparte el sufijo de
      // 6 dígitos, y compliance gana por sufijo (M1, matchManualContacts).
      const result = await useCase.execute(
        baseInput({ recipients: [{ phone: MOBILE_A }, { phone: '336415123456' }] }),
      );

      expect(result.invalid).toContainEqual({ input: '336415123456', reason: 'opt_out' });
    });
  });

  /**
   * fix wave F3 (S1, smoke en vivo) — LIVE: `{"phone":"1178547218"}` → excluido
   * como `non_mobile` → 422 EMPTY_RECIPIENTS, aunque el `send` (`toWhatsAppE164`)
   * SIEMPRE reconstruye ese mismo crudo como `+5491178547218`. `classifyArPhone`
   * pasa a ser un wrapper CONSISTENTE con `toWhatsAppE164`: mobile ssi (a) no es
   * un extranjero explícito (`+`/`00` + país≠54 → invalid, intacto) y (b)
   * `toWhatsAppE164(raw)` no da `null`. `non_mobile` deja de emitirse (el
   * literal sigue en `ExternalBulkInvalidReason` por estabilidad de contrato).
   */
  describe('fix wave F3 (S1) — classifyArPhone consistente con toWhatsAppE164 (10 dígitos = móvil AR)', () => {
    const CANONICAL_E164 = '+5491178547218';

    it.each([
      ['1178547218', '10 dígitos limpio (LIVE, el caso reportado)'],
      ['11 7854-7218', '10 dígitos con espacios/guión'],
      ['011 15 7854 7218', 'discado nacional [área][15][abonado]'],
      ['+54 9 11 7854 7218', 'E.164 explícito con "9"'],
      ['549 11 7854 7218', 'country-code + "9" sin "+"'],
    ])('%s (%s) → valid, mismo E.164 canónico', async (raw) => {
      const { useCase } = await setup();

      const result = await useCase.execute(baseInput({ recipients: [{ phone: raw }] }));

      expect(result.valid).toHaveLength(1);
      expect(result.valid[0]?.phone).toBe(CANONICAL_E164);
      expect(result.invalid).toEqual([]);
    });

    it('extranjero de 12 dígitos con "+" (Brasil) → invalid, NUNCA reconstruido como +549…', async () => {
      const { useCase } = await setup();

      const result = await useCase.execute(
        baseInput({ recipients: [{ phone: MOBILE_A }, { phone: '+5511999999999' }] }),
      );

      expect(result.invalid).toContainEqual({ input: '+5511999999999', reason: 'telefono_invalido' });
    });

    it('extranjero corto con "+" (USA) → invalid', async () => {
      const { useCase } = await setup();

      const result = await useCase.execute(
        baseInput({ recipients: [{ phone: MOBILE_A }, { phone: '+1 555 123 4567' }] }),
      );

      expect(result.invalid).toContainEqual({ input: '+1 555 123 4567', reason: 'telefono_invalido' });
    });

    it('extranjero con prefijo de acceso "00" (España) → invalid', async () => {
      const { useCase } = await setup();

      const result = await useCase.execute(
        baseInput({ recipients: [{ phone: MOBILE_A }, { phone: '0034911223344' }] }),
      );

      expect(result.invalid).toContainEqual({ input: '0034911223344', reason: 'telefono_invalido' });
    });

    it('mismo número en 2 formatos → el 2do cae duplicado (mismo E.164)', async () => {
      const { useCase } = await setup();

      const result = await useCase.execute(
        baseInput({ recipients: [{ phone: '1178547218' }, { phone: '011 15 7854 7218' }] }),
      );

      expect(result.valid).toHaveLength(1);
      expect(result.invalid).toEqual([{ input: '011 15 7854 7218', reason: 'duplicado' }]);
    });

    // Pin: los no-dígitos se stripean IGUAL que en `toWhatsAppE164` — un sufijo
    // de basura ("x") no cambia el E.164 reconstruido, así que colisiona con el
    // mismo número ya visto → `duplicado`, NO un móvil "distinto".
    it('garbage no-dígito pegado al mismo número → duplicado (mismos dígitos tras el strip)', async () => {
      const { useCase } = await setup();

      const result = await useCase.execute(
        baseInput({ recipients: [{ phone: '1178547218' }, { phone: '1178547218x' }] }),
      );

      expect(result.valid).toHaveLength(1);
      expect(result.invalid).toEqual([{ input: '1178547218x', reason: 'duplicado' }]);
    });
  });

  describe('VAL-3 — renderizado del mensaje POR RECIPIENT', () => {
    it('dos recipients con variables distintas → dos renderedMessage distintos; el de nivel superior es el del 1ro', async () => {
      const { useCase } = await setup();

      const result = await useCase.execute(
        baseInput({
          variables: { '1': 'Default' },
          recipients: [
            { phone: MOBILE_A, variables: { '1': 'Ana' } },
            { phone: MOBILE_B, variables: { '1': 'Beto' } },
          ],
        }),
      );

      expect(result.valid[0].renderedMessage).toBe('Hola Ana');
      expect(result.valid[1].renderedMessage).toBe('Hola Beto');
      expect(result.renderedMessage).toBe('Hola Ana');
    });

    it('sin recipients válidos → 422 EMPTY_RECIPIENTS, sin persistir preview', async () => {
      const { useCase, previewRepo } = await setup();
      const createSpy = jest.spyOn(previewRepo, 'create');

      await expect(useCase.execute(baseInput({ recipients: [{ phone: '123' }] }))).rejects.toThrow(
        EmptyRecipientsError,
      );
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe('VAL-4 — template debe estar APROBADO', () => {
    it('template pending → TemplateNotApprovedError (422), sin persistir preview', async () => {
      const pending: TemplateDto = { ...TEMPLATE, approvalStatus: 'pending' };
      const { useCase, previewRepo } = await setup({ templates: [pending] });
      const createSpy = jest.spyOn(previewRepo, 'create');

      await expect(useCase.execute(baseInput())).rejects.toThrow(TemplateNotApprovedError);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('templateRef inexistente en el proveedor → TemplateNotApprovedError', async () => {
      const { useCase } = await setup();

      await expect(useCase.execute(baseInput({ templateRef: 'HXghost' }))).rejects.toThrow(TemplateNotApprovedError);
    });

    it('templateName ambiguo (2+ templates con el mismo friendlyName) → TemplateNotApprovedError', async () => {
      const dup: TemplateDto = { ...TEMPLATE, contentSid: 'HXdup' };
      const { useCase } = await setup({ templates: [TEMPLATE, dup] });

      await expect(
        useCase.execute(baseInput({ templateRef: undefined, templateName: TEMPLATE.friendlyName })),
      ).rejects.toThrow(TemplateNotApprovedError);
    });
  });

  describe('VAL-5 — label de Chatwoot debe existir en el catálogo vivo', () => {
    it('label inexistente → ChatwootLabelNotFoundError (422), sin persistir preview', async () => {
      const { useCase, chatwootGateway, previewRepo } = await setup();
      chatwootGateway.accountLabelsResult = [{ title: 'otro-label', color: '#fff' }];
      const createSpy = jest.spyOn(previewRepo, 'create');

      await expect(useCase.execute(baseInput({ chatwootLabel: 'no-existe' }))).rejects.toThrow(
        ChatwootLabelNotFoundError,
      );
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('Chatwoot inalcanzable → ChatwootUnavailableError (503), sin preview ni aceptar a ciegas', async () => {
      const { useCase, chatwootGateway, previewRepo } = await setup();
      chatwootGateway.failListAccountLabels = true;
      const createSpy = jest.spyOn(previewRepo, 'create');

      await expect(useCase.execute(baseInput({ chatwootLabel: 'promo' }))).rejects.toThrow(ChatwootUnavailableError);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('label existente → éxito, chatwootLabel queda persistido en el preview', async () => {
      const { useCase, chatwootGateway, previewRepo } = await setup();
      chatwootGateway.accountLabelsResult = [{ title: 'promo-agosto', color: '#fff' }];

      const result = await useCase.execute(baseInput({ chatwootLabel: 'promo-agosto' }));

      const preview = await previewRepo.findById(result.previewId);
      expect(preview?.chatwootLabel).toBe('promo-agosto');
    });
  });

  describe('VAL-6 — tope por request (maxPerRequest)', () => {
    it('valid.length > maxPerRequest → CAP_EXCEEDED perRequest, sin persistir preview', async () => {
      const { useCase, configRepo, previewRepo } = await setup();
      await configRepo.set({ maxPerRequest: 1, maxPerDay: 2000 });
      const createSpy = jest.spyOn(previewRepo, 'create');

      await expect(
        useCase.execute(baseInput({ recipients: [{ phone: MOBILE_A }, { phone: MOBILE_B }] })),
      ).rejects.toMatchObject({ code: 'CAP_EXCEEDED', limit: 'perRequest', maxPerRequest: 1, received: 2 });
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe('VAL-7 — tope diario (maxPerDay) sobre los destinatarios AUTORIZADOS (creados, no skipped/opted_out) (fix wave F2)', () => {
    it('cupo diario ya consumido por envíos previos → CAP_EXCEEDED perDay', async () => {
      const { useCase, configRepo, campaignRepo, apiMessagingUserId } = await setup();
      await configRepo.set({ maxPerRequest: 500, maxPerDay: 2 });
      const previous = await campaignRepo.create({
        name: 'previo',
        templateRef: TEMPLATE.contentSid,
        segment: { statuses: [] },
        variableSpec: {},
        total: 2,
        createdById: apiMessagingUserId,
      });
      const rows = await campaignRepo.bulkCreateRecipients(previous.id, [
        { clientId: null, phoneNormalized: '111', phoneE164: '+549111' },
        { clientId: null, phoneNormalized: '222', phoneE164: '+549222' },
      ]);
      await campaignRepo.updateRecipient(rows[0].id, { status: 'sent', sentAt: '2026-09-02T10:00:00.000Z' });
      await campaignRepo.updateRecipient(rows[1].id, { status: 'sent', sentAt: '2026-09-02T10:00:00.000Z' });

      await expect(useCase.execute(baseInput({ recipients: [{ phone: MOBILE_A }] }))).rejects.toMatchObject({
        code: 'CAP_EXCEEDED',
        limit: 'perDay',
        remainingToday: 0,
      });
    });

    it('previews NO consumidos no descuentan cupo', async () => {
      const { useCase, configRepo } = await setup();
      await configRepo.set({ maxPerRequest: 500, maxPerDay: 1 });

      await useCase.execute(baseInput({ recipients: [{ phone: MOBILE_A }] }));
      const second = await useCase.execute(baseInput({ recipients: [{ phone: MOBILE_B }] }));

      expect(second.caps.remainingToday).toBe(1);
    });
  });

  describe('VAL-8 — preview persistido con hash + expiración de 15 min', () => {
    it('dos validate idénticos generan DOS previews independientes, cada uno con su propio expiresAt', async () => {
      const { useCase } = await setup();
      const input = baseInput();

      const r1 = await useCase.execute(input);
      const r2 = await useCase.execute(input);

      expect(r1.previewId).not.toBe(r2.previewId);
      expect(new Date(r1.expiresAt).getTime()).toBe(NOW.getTime() + 15 * 60 * 1000);
    });
  });

  describe('VAL-9 — forma de la respuesta', () => {
    it('batch mixto: counts cuadran a mano (2 válidos, 1 duplicado, 1 opt-out, 1 formato inválido)', async () => {
      const { useCase } = await setup({
        clients: [makeCandidate({ clientId: 'c1', phone: '3364111111', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' })],
      });

      const result = await useCase.execute(
        baseInput({
          recipients: [
            { phone: MOBILE_A },
            { phone: MOBILE_B },
            { phone: MOBILE_A_ALT_FORMAT }, // duplicado de MOBILE_A
            { phone: '3364111111' }, // opt-out
            { phone: '123' }, // formato inválido
          ],
        }),
      );

      expect(result.counts).toEqual({ received: 5, valid: 2, invalid: 3, optedOut: 1, duplicated: 1 });
      expect(result.valid).toHaveLength(2);
      expect(result.valid[0]).toMatchObject({ variables: { '1': 'Cliente' } });
      expect(result.invalid).toHaveLength(3);
    });
  });

  describe('VAL-10 — resolución de variables POR RECIPIENT', () => {
    it('el valor por-recipient pisa al global por key (las globales que no pisa sobreviven)', async () => {
      const tpl: TemplateDto = { ...TEMPLATE, variables: { '1': 'x', '2': 'y' }, body: 'Hola {{1}}, hoy es {{2}}' };
      const { useCase } = await setup({ templates: [tpl] });

      const result = await useCase.execute(
        baseInput({
          variables: { '1': 'Cliente', '2': 'hoy' },
          recipients: [{ phone: MOBILE_A, variables: { '1': 'Ana' } }],
        }),
      );

      expect(result.valid[0].variables).toEqual({ '1': 'Ana', '2': 'hoy' });
    });

    it('variable faltante invalida SOLO a ese recipient (200, NUNCA 422 MISSING_TEMPLATE_VARIABLES)', async () => {
      const tpl: TemplateDto = { ...TEMPLATE, variables: { '1': 'x', '2': 'y' }, body: 'Hola {{1}} {{2}}' };
      const { useCase } = await setup({ templates: [tpl] });

      const result = await useCase.execute(
        baseInput({
          variables: { '1': 'Hola' },
          recipients: [
            { phone: MOBILE_A, variables: { '2': 'Ana' } }, // A: válido — '1' viene del global
            { phone: MOBILE_B }, // B: sin variables propias → falta '2'
          ],
        }),
      );

      expect(result.valid).toHaveLength(1);
      expect(result.invalid).toEqual([
        { input: MOBILE_B, reason: 'variables_faltantes', missingVariables: ['2'] },
      ]);
    });

    it('variable EXTRA no declarada — permitida e ignorada en el render', async () => {
      const { useCase } = await setup();

      const result = await useCase.execute(
        baseInput({ recipients: [{ phone: MOBILE_A, variables: { '1': 'Ana', '99': 'basura' } }] }),
      );

      expect(result.valid).toHaveLength(1);
      expect(result.valid[0].renderedMessage).toBe('Hola Ana');
    });

    it('el hash distingue el `variables` de UN recipient (dos batches, mismo lote salvo esa variable)', async () => {
      const s1 = await setup();
      const s2 = await setup();

      const r1 = await s1.useCase.execute(
        baseInput({ recipients: [{ phone: MOBILE_A, variables: { '1': 'Ana' } }] }),
      );
      const r2 = await s2.useCase.execute(
        baseInput({ recipients: [{ phone: MOBILE_A, variables: { '1': 'Beto' } }] }),
      );

      const p1 = await s1.previewRepo.findById(r1.previewId);
      const p2 = await s2.previewRepo.findById(r2.previewId);

      expect(p1!.payloadHash).not.toBe(p2!.payloadHash);
    });
  });

  /**
   * fix wave F1 (finding F4) — clamp DEFENSIVO. `SetExternalBulkConfig` ya
   * rechaza `maxPerRequest > MAX_MANUAL_CONTACTS`, pero la fila de config es
   * editable por otras vias (SQL a mano, un seed viejo): si igual llega un tope
   * mayor, `validate` NO puede prometer un lote que el `send` no va a despachar.
   */
  describe('fix wave F1 (F4) — clamp defensivo del tope por request', () => {
    it('config con maxPerRequest > MAX_MANUAL_CONTACTS → el cap efectivo es MAX_MANUAL_CONTACTS (y `caps` lo reporta)', async () => {
      const { useCase, configRepo } = await setup();
      jest
        .spyOn(configRepo, 'get')
        .mockResolvedValue({ maxPerRequest: 999999, maxPerDay: 999999, updatedAt: NOW.toISOString() });

      const result = await useCase.execute(baseInput());

      expect(result.caps.maxPerRequest).toBe(MAX_MANUAL_CONTACTS);
    });
  });

  /**
   * fix wave F1 (finding F11) — `hasArMobileMarker` devolvia `true` para
   * CUALQUIER numero de 12 digitos. Un movil extranjero de 12 digitos cuyo
   * "15" cae en un borde de area AR valido (ej. Colombia +57 315 234 5678)
   * pasaba el gate de movil Y `toWhatsAppE164` lo reconstruia como
   * `+549<basura>` — un ENVIO A UN NUMERO EQUIVOCADO, plata real a un tercero.
   * Regla nueva: si el crudo viene en formato INTERNACIONAL explicito (`+` o
   * `00`) y el pais NO es 54, es `telefono_invalido` — nunca se cae al `+549`.
   */
  describe('fix wave F1 (F11) — numeros extranjeros nunca se reconstruyen como AR', () => {
    it.each([
      ['+55 11 3456 7890', 'Brasil'],
      ['+57 315 234 5678', 'Colombia — 12 digitos con "15" en un borde de area AR valido'],
      ['+1 234 567 8901', 'EEUU'],
      ['+34 612 345 678', 'Espana'],
      ['+598 99 123 456', 'Uruguay'],
      ['0055 11 3456 7890', 'Brasil con prefijo de acceso internacional 00'],
    ])('%s (%s) → invalid telefono_invalido, jamas un +549', async (phone) => {
      const { useCase, previewRepo } = await setup();
      const createSpy = jest.spyOn(previewRepo, 'create');

      await expect(useCase.execute(baseInput({ recipients: [{ phone }] }))).rejects.toMatchObject({
        code: 'EMPTY_RECIPIENTS',
      });
      expect(createSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['+54 9 11 2345-6789', 'E.164 AR movil completo'],
      ['54 9 11 2345-6789', 'AR movil sin el "+"'],
      ['011 15-2345-6789', 'local con troncal 0 + "15" movil'],
      ['11 15-2345-6789', 'local sin troncal, con "15" movil'],
    ])('%s (%s) → sigue siendo un movil AR valido (+5491123456789)', async (phone) => {
      const { useCase } = await setup();

      const result = await useCase.execute(baseInput({ recipients: [{ phone }] }));

      expect(result.valid).toHaveLength(1);
      expect(result.valid[0].phone).toBe('+5491123456789');
    });
  });

  /**
   * fix wave F1 (finding F12) — las variables NO declaradas por el template
   * viajaban hasta `CampaignRecipient.variables` y de ahi al proveedor
   * (`SendCampaign` spreadea el mapa completo y `TwilioContentGateway`
   * serializa todo). Se filtran al conjunto DECLARADO antes de persistir el
   * preview, que es tambien lo que entra al `payloadHash`.
   */
  describe('fix wave F1 (F12) — solo las variables DECLARADAS se persisten', () => {
    it('una key extra no declarada no queda en el preview persistido ni en `valid[].variables`', async () => {
      const { useCase, previewRepo } = await setup();

      const result = await useCase.execute(
        baseInput({ recipients: [{ phone: MOBILE_A, variables: { '1': 'Ana', '99': 'basura' } }] }),
      );

      expect(result.valid[0].variables).toEqual({ '1': 'Ana' });
      const preview = await previewRepo.findById(result.previewId);
      expect(preview!.recipients[0]!.variables).toEqual({ '1': 'Ana' });
    });
  });

  /**
   * fix wave F1 (finding F13) — VERIFICADO: `matchManualContacts` vincula por
   * igualdad EXACTA de `normalizePhone` (`byPhone.get(phoneNormalized)`), NO
   * por sufijo — el indice de sufijos solo EXCLUYE opt-outs, nunca vincula. No
   * hizo falta cambiar codigo; este test PINEA la propiedad para que un futuro
   * cambio a match por sufijo no reescriba en silencio el destino del envio.
   */
  describe('fix wave F1 (F13) — el destino enviado es SIEMPRE el numero del caller', () => {
    it('vinculado a un Client (match EXACTO por normalizePhone): el E.164 sigue siendo el del INPUT', async () => {
      // Mismo numero, OTRO formato: ambos normalizan a "111523456789" (match exacto).
      const client = makeCandidate({ clientId: 'c1', name: 'Juan Cliente', phone: '+54 11 15-2345-6789' });
      const { useCase } = await setup({ clients: [client] });

      const result = await useCase.execute(baseInput({ recipients: [{ phone: MOBILE_A }] }));

      expect(result.valid).toHaveLength(1);
      expect(result.valid[0].phone).toBe('+5491123456789');
    });

    it('un Client que solo comparte el SUFIJO NO vincula: el destino sigue siendo el numero del caller', async () => {
      // Comparte los ultimos 6 digitos ("456789") pero es OTRO numero: el
      // indice de sufijos de `matchManualContacts` solo excluye opt-outs, no vincula.
      const otro = makeCandidate({ clientId: 'c2', name: 'Otro Titular', phone: '3364 456789' });
      const { useCase } = await setup({ clients: [otro] });

      const result = await useCase.execute(baseInput({ recipients: [{ phone: MOBILE_A }] }));

      expect(result.valid).toHaveLength(1);
      expect(result.valid[0].phone).toBe('+5491123456789');
    });
  });

  describe('D9 — purga best-effort de previews vencidos', () => {
    it('preview vencido de hace más de 24h desaparece tras un validate nuevo', async () => {
      const { useCase, previewRepo } = await setup();
      const stale = await previewRepo.create({
        payloadHash: 'stale-hash',
        templateRef: TEMPLATE.contentSid,
        templateName: TEMPLATE.friendlyName,
        variables: {},
        chatwootLabel: null,
        recipients: [],
        invalid: [],
        validCount: 0,
        invalidCount: 0,
        expiresAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(),
      });

      await useCase.execute(baseInput());

      expect(await previewRepo.findById(stale.id)).toBeNull();
    });

    it('fallo del delete NO rompe la respuesta 200 de un validate exitoso', async () => {
      const { useCase, previewRepo } = await setup();
      jest.spyOn(previewRepo, 'deleteExpiredBefore').mockRejectedValue(new Error('boom'));

      const result = await useCase.execute(baseInput());

      expect(result.previewId).toEqual(expect.any(String));
    });
  });

  /**
   * twilio-credit-guard (Batch 2, task 2.5/2.6, CG-VAL-1/CG-VAL-2) — el
   * bloque `credit` es ADVISORY: nunca convierte un 200 en error, corre
   * DESPUÉS de los caps, y se persiste en el snapshot del preview FUERA del
   * `payloadHash`.
   */
  describe('twilio-credit-guard — bloque credit ADVISORY en validate (CG-VAL-1/CG-VAL-2)', () => {
    it('credit viaja en la respuesta 200 (categoría del template ausente ⇒ MARKETING asumida)', async () => {
      const { useCase } = await setup();

      const result = await useCase.execute(baseInput());

      expect(result.credit).toMatchObject({
        available: '17.8940',
        currency: 'USD',
        category: 'MARKETING',
        categoryAssumed: true,
        unitCost: '0.0668',
        estimatedCost: '0.0668',
        sufficient: true,
      });
      expect(result.warnings).toBeUndefined();
    });

    it('crédito insuficiente ⇒ 200 (NUNCA 4xx) con warnings:[INSUFFICIENT_CREDIT]', async () => {
      const { useCase, creditPort } = await setup();
      creditPort.amount = '0.0001';

      const result = await useCase.execute(baseInput());

      expect(result.credit.sufficient).toBe(false);
      expect(result.credit.unknown).toBeUndefined();
      expect(result.warnings).toEqual(['INSUFFICIENT_CREDIT']);
    });

    it('creditPort.getBalance() lanza ⇒ 200 con credit.unknown:true y warnings:[CREDIT_UNAVAILABLE], JAMÁS voltea el request', async () => {
      const { useCase, creditPort } = await setup();
      creditPort.failNext = true;

      const result = await useCase.execute(baseInput());

      expect(result.credit.unknown).toBe(true);
      expect(result.credit.sufficient).toBe(false);
      expect(result.warnings).toEqual(['CREDIT_UNAVAILABLE']);
    });

    /**
     * fix wave F1 (F4) — antes este test pineaba el fallback a
     * `MESSAGING_RATES_CONFIG_DEFAULTS`: si la DB de tarifas se caía, `validate`
     * mostraba un costo con tarifas INVENTADAS como si fuera el real. Adivinar
     * la tarifa es exactamente lo que D4.c prohíbe. Ahora degrada a `unknown`,
     * que es la verdad — y sigue sin voltear el request (CG-VAL-1).
     */
    it('ratesRepo.get() lanza ⇒ 200 con credit.unknown:true + warnings:[CREDIT_UNAVAILABLE], SIN inventar defaults', async () => {
      const { useCase, ratesRepo } = await setup();
      jest.spyOn(ratesRepo, 'get').mockRejectedValue(new Error('db down'));

      const result = await useCase.execute(baseInput());

      expect(result.credit.unknown).toBe(true);
      expect(result.credit.sufficient).toBe(false);
      expect(result.credit.unitCost).toBeNull();
      expect(result.credit.estimatedCost).toBeNull();
      expect(result.warnings).toEqual(['CREDIT_UNAVAILABLE']);
    });

    it('el credit de la respuesta viaja TAMBIÉN al snapshot persistido del preview', async () => {
      const { useCase, previewRepo } = await setup();
      const createSpy = jest.spyOn(previewRepo, 'create');

      const result = await useCase.execute(baseInput());

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ credit: result.credit }));
      const preview = await previewRepo.findById(result.previewId);
      expect(preview?.credit).toEqual(result.credit);
    });

    it('payloadHash IDÉNTICO al valor de antes de este change (literal hardcodeado, pin de no-regresión CG-VAL-2)', async () => {
      const { useCase, previewRepo } = await setup();

      const result = await useCase.execute(baseInput());

      const preview = await previewRepo.findById(result.previewId);
      // Literal capturado con el algoritmo de `externalBulkPayloadHash` SIN
      // TOCAR (twilio-credit-guard no modifica ese archivo) — el crédito NUNCA
      // participa del hash aunque las tarifas cambien.
      expect(preview?.payloadHash).toBe('b9deaf15c46833d24da7bee0d9de80641e9038442d9f8de9583b8047499b886a');
    });

    it('el hash NO cambia si las tarifas cambian entre dos previews del MISMO payload (CG-VAL-2)', async () => {
      const { useCase, previewRepo, ratesRepo } = await setup();
      const input = baseInput();

      const r1 = await useCase.execute(input);
      await ratesRepo.set({
        currency: 'USD',
        utilityRate: '0.5000',
        marketingRate: '0.9000',
        authenticationRate: '0.5000',
        providerFee: '0.5000',
      });
      const r2 = await useCase.execute(input);

      const p1 = await previewRepo.findById(r1.previewId);
      const p2 = await previewRepo.findById(r2.previewId);
      expect(p1!.payloadHash).toBe(p2!.payloadHash);
      // Y sin embargo el credit calculado SÍ cambió (prueba que el cálculo corrió de nuevo).
      expect(p1!.credit!.unitCost).not.toBe(p2!.credit!.unitCost);
    });

    it('CG-VAL-1 — orden: crédito corre DESPUÉS de los caps (un cap excedido NUNCA llama getBalance())', async () => {
      const { useCase, configRepo, creditPort } = await setup();
      await configRepo.set({ maxPerRequest: 1, maxPerDay: 2000 });
      const getBalanceSpy = jest.spyOn(creditPort, 'getBalance');

      await expect(
        useCase.execute(baseInput({ recipients: [{ phone: MOBILE_A }, { phone: MOBILE_B }] })),
      ).rejects.toMatchObject({ code: 'CAP_EXCEEDED' });

      expect(getBalanceSpy).not.toHaveBeenCalled();
      expect(creditPort.calls).toBe(0);
    });

    /**
     * fix wave F1 (F8) — cuando el bloque es `unknown` por TARIFA ilegible, los
     * números no pueden decir '0.0000'. La card FE y la IA que consume la API
     * externa leen un cero como "gratis".
     */
    it('tarifa ilegible en la fila ⇒ unitCost/estimatedCost null (NO "0.0000")', async () => {
      const { useCase, ratesRepo } = await setup();
      await ratesRepo.set({
        currency: 'USD',
        utilityRate: '0.0120',
        marketingRate: 'not-a-number',
        authenticationRate: '0.0220',
        providerFee: '0.0050',
      });

      const result = await useCase.execute(baseInput());

      expect(result.credit.unknown).toBe(true);
      expect(result.credit.unitCost).toBeNull();
      expect(result.credit.estimatedCost).toBeNull();
      expect(result.warnings).toEqual(['CREDIT_UNAVAILABLE']);
    });

    /** fix wave F1 (F6) — overflow de punto fijo: `unknown`, jamás un 500. */
    it('tarifa monstruosa (overflow de safe-integer al multiplicar) ⇒ 200 con unknown:true, nunca revienta', async () => {
      const { useCase, ratesRepo } = await setup();
      await ratesRepo.set({
        currency: 'USD',
        utilityRate: '0.0120',
        marketingRate: '900000000000.0000',
        authenticationRate: '0.0220',
        providerFee: '0.0000',
      });

      const result = await useCase.execute(
        baseInput({ recipients: [{ phone: MOBILE_A }, { phone: MOBILE_B }] }),
      );

      expect(result.credit.unknown).toBe(true);
      expect(result.credit.estimatedCost).toBeNull();
      expect(result.warnings).toEqual(['CREDIT_UNAVAILABLE']);
    });
  });

  /**
   * fix wave F1 (F7) — perilla PROPIA del guard de crédito
   * (`messaging-credit-guard-enabled`, sembrada en TRUE). Sin ella, el único
   * botón ante un falso positivo del guard era apagar la API externa ENTERA
   * (`messaging-external-bulk-enabled`) — matar el envío para arreglar el
   * medidor. Apagarla es fail-OPEN por decisión EXPLÍCITA del operador.
   */
  describe('CG-FLAG — feature flag messaging-credit-guard-enabled (fix wave F1, F7)', () => {
    const GUARD_FLAG_KEY = 'messaging-credit-guard-enabled';

    it('flag OFF ⇒ credit.unknown:true + warnings:[CREDIT_GUARD_DISABLED], y NO se le pega al proveedor', async () => {
      const { useCase, featureFlags, creditPort } = await setup();
      featureFlags.seed(GUARD_FLAG_KEY, false);

      const result = await useCase.execute(baseInput());

      expect(result.credit.unknown).toBe(true);
      expect(result.credit.sufficient).toBe(false);
      expect(result.credit.unitCost).toBeNull();
      expect(result.credit.estimatedCost).toBeNull();
      expect(result.warnings).toEqual(['CREDIT_GUARD_DISABLED']);
      expect(creditPort.calls).toBe(0);
    });

    it('flag ON explícito ⇒ el bloque credit se calcula normalmente', async () => {
      const { useCase, featureFlags, creditPort } = await setup();
      featureFlags.seed(GUARD_FLAG_KEY, true);

      const result = await useCase.execute(baseInput());

      expect(result.credit.unknown).toBeUndefined();
      expect(creditPort.calls).toBe(1);
    });

    it('la fila del flag NO existe ⇒ guard PRENDIDO (fail-closed, al revés que el kill-switch)', async () => {
      const { useCase, creditPort } = await setup();

      const result = await useCase.execute(baseInput());

      expect(result.credit.unknown).toBeUndefined();
      expect(creditPort.calls).toBe(1);
    });

    it('el repo de flags REVIENTA ⇒ guard PRENDIDO (un repo caído no apaga una protección)', async () => {
      const { useCase, featureFlags, creditPort } = await setup();
      const realGet = featureFlags.get.bind(featureFlags);
      jest.spyOn(featureFlags, 'get').mockImplementation(async (key: string) => {
        if (key === GUARD_FLAG_KEY) throw new Error('db down');
        return realGet(key);
      });

      const result = await useCase.execute(baseInput());

      expect(result.credit.unknown).toBeUndefined();
      expect(creditPort.calls).toBe(1);
    });
  });

  describe('guard adicional (D15) — api-messaging no bootstrapeado', () => {
    it('rbacUserRepo.findByLogin("api-messaging") → null ⇒ ReporterUnavailableError (503)', async () => {
      const { useCase } = await setup({ bootstrapApiMessaging: false });

      await expect(useCase.execute(baseInput())).rejects.toThrow(ReporterUnavailableError);
    });
  });
});
