/**
 * inbox-template-send (TS-1..TS-6, design D9) — SendTemplateMessage. Envía UN
 * template WhatsApp (Twilio Content directo, D1) desde el hilo YA abierto por
 * el agente. Guard order PINNED (conversación → teléfono → template aprobado →
 * variables completas → envío), sin side effects hasta el paso 5. El template
 * NUNCA abre la ventana de 24h (D2) — canReply/status quedan intactos siempre.
 * Fakes in-memory (NUNCA mock de Prisma, convención del repo).
 */
import { SendTemplateMessage } from '@application/use-cases/messaging/SendTemplateMessage';
import { ConversationNotFoundError, ConversationPhoneMissingError } from '@domain/errors/messaging';
import { TemplateNotApprovedError, MissingTemplateVariablesError, TemplateSendRejectedError, TemplateProviderUnavailableError } from '@domain/errors/messaging-bulk';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';
import type { ConversationRepository, ConversationRecord } from '@domain/ports/ConversationRepository';

/**
 * TS-2 fallback scenario ("pre-backfill" row: `contactPhoneE164:null` but
 * `contactPhone` still convertible) is UNREACHABLE through
 * `InMemoryConversationRepository.upsertByChatwootId` — that adapter ALWAYS
 * derives `contactPhoneE164` from `contactPhone` on write (same as Prisma).
 * A hand-rolled fake conforming to the PORT (never a Prisma mock) is the only
 * way to reproduce that historical state for the test below.
 */
function fixedConversationRepo(record: ConversationRecord): ConversationRepository {
  return {
    findById: async (id: string) => (id === record.id ? { ...record } : null),
    findByChatwootId: async () => null,
    upsertByChatwootId: async () => {
      throw new Error('fixedConversationRepo: upsertByChatwootId not needed by this test');
    },
    upsertBulkByPhone: async () => {
      throw new Error('fixedConversationRepo: upsertBulkByPhone not needed by this test');
    },
    adoptBulkConversation: async () => null,
    list: async () => ({ data: [], total: 0, page: 1, limit: 25 }),
    updateLocalFields: async () => null,
    bumpLastMessage: async () => ({ ...record }),
  };
}

function makeConversationRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conv-fallback',
    chatwootConversationId: 1,
    origin: 'chatwoot',
    contactName: null,
    contactPhone: null,
    contactPhoneE164: null,
    status: 'open',
    canReply: false,
    lastMessageAt: null,
    lastMessagePreview: null,
    assigneeId: null,
    assigneeName: null,
    areaId: null,
    areaName: null,
    areaColor: null,
    campaigns: [],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

const APPROVED_TEMPLATE: TemplateDto = {
  contentSid: 'HX1',
  friendlyName: 'Recordatorio deuda',
  language: 'es',
  variables: { '1': 'nombre', '2': 'monto' },
  approvalStatus: 'approved',
  body: 'Hola {{1}}, debés {{2}}',
};

const PENDING_TEMPLATE: TemplateDto = {
  contentSid: 'HX9',
  friendlyName: 'Pendiente',
  language: 'es',
  variables: {},
  approvalStatus: 'pending',
  body: 'Pendiente',
};

function makeHarness(opts: { templates?: TemplateDto[]; rejectPhone?: string; failNthWith429?: number } = {}) {
  const conversationRepo = new InMemoryConversationRepository();
  const messageRepo = new InMemoryChatMessageRepository();
  const templatePort = new InMemoryTemplateMessagingGateway({
    templates: opts.templates ?? [APPROVED_TEMPLATE, PENDING_TEMPLATE],
    rejectPhone: opts.rejectPhone,
    failNthWith429: opts.failNthWith429,
  });
  const uc = new SendTemplateMessage(conversationRepo, templatePort, messageRepo);
  return { conversationRepo, messageRepo, templatePort, uc };
}

describe('SendTemplateMessage', () => {
  describe('TS-1 — guard 1: conversación existe', () => {
    it('conversación inexistente → 404 ConversationNotFoundError, cero llamadas a sendTemplate', async () => {
      const { templatePort, uc } = makeHarness();

      await expect(uc.execute('nope', 'HX1', {})).rejects.toBeInstanceOf(ConversationNotFoundError);
      expect(templatePort.calls).toHaveLength(0);
    });
  });

  describe('TS-2 — guard 2: teléfono resoluble', () => {
    it('contactPhoneE164 y contactPhone ambos null → ConversationPhoneMissingError, cero envío', async () => {
      const { conversationRepo, templatePort, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 1 });

      await expect(uc.execute(conv.id, 'HX1', { '1': 'Juan', '2': '$5.000' })).rejects.toBeInstanceOf(
        ConversationPhoneMissingError,
      );
      expect(templatePort.calls).toHaveLength(0);
    });

    it('contactPhoneE164 null pero contactPhone convertible (fila pre-backfill) → sendTemplate recibe el E164 derivado (fallback toWhatsAppE164)', async () => {
      const { messageRepo, templatePort } = makeHarness();
      const record = makeConversationRecord({
        id: 'conv-fallback',
        contactPhoneE164: null,
        contactPhone: '011 15-2345-6789',
      });
      const uc = new SendTemplateMessage(fixedConversationRepo(record), templatePort, messageRepo);

      await uc.execute(record.id, 'HX1', { '1': 'Juan', '2': '$5.000' });

      expect(templatePort.calls[0]!.to).toBe('+5491123456789');
    });
  });

  describe('TS-3 — guard 3: template aprobado (CAMP-2)', () => {
    it('template pending → TemplateNotApprovedError, cero sendTemplate', async () => {
      const { conversationRepo, templatePort, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 3, contactPhone: '+5491123456789' });

      await expect(uc.execute(conv.id, 'HX9', {})).rejects.toBeInstanceOf(TemplateNotApprovedError);
      expect(templatePort.calls).toHaveLength(0);
    });

    it('templateRef inexistente en el proveedor → TemplateNotApprovedError (igual que no-aprobado)', async () => {
      const { conversationRepo, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 4, contactPhone: '+5491123456789' });

      await expect(uc.execute(conv.id, 'HX-no-existe', {})).rejects.toBeInstanceOf(TemplateNotApprovedError);
    });
  });

  describe('TS-4 — guard 4: variables completas (CAMP-3)', () => {
    it('falta una variable declarada → MissingTemplateVariablesError con missing:[...], cero envío', async () => {
      const { conversationRepo, templatePort, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 5, contactPhone: '+5491123456789' });

      const err = await uc.execute(conv.id, 'HX1', { '1': 'Juan' }).catch((e) => e);

      expect(err).toBeInstanceOf(MissingTemplateVariablesError);
      expect(err.missing).toEqual(['2']);
      expect(templatePort.calls).toHaveLength(0);
    });

    it('variables extra no declaradas NO bloquean', async () => {
      const { conversationRepo, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 6, contactPhone: '+5491123456789' });

      await expect(
        uc.execute(conv.id, 'HX1', { '1': 'Juan', '2': '$5.000', '3': 'extra' }),
      ).resolves.toBeDefined();
    });
  });

  describe('TS-5 — envío por el port, errores tipados propagan, SIN retry, CERO persistencia en falla', () => {
    it('Twilio rechaza (4xx per-mensaje) → propaga TemplateSendRejectedError, mirror EXACTAMENTE como estaba', async () => {
      const { conversationRepo, messageRepo, uc } = makeHarness({ rejectPhone: '+5491123456789' });
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 7, contactPhone: '+5491123456789' });

      await expect(uc.execute(conv.id, 'HX1', { '1': 'Juan', '2': '$5.000' })).rejects.toBeInstanceOf(
        TemplateSendRejectedError,
      );

      expect(await messageRepo.listByConversation(conv.id)).toHaveLength(0);
      const stillConv = await conversationRepo.findById(conv.id);
      expect(stillConv!.lastMessagePreview).toBeNull();
    });

    it('proveedor caído (429/5xx) → propaga TemplateProviderUnavailableError, cero persistencia', async () => {
      const { conversationRepo, messageRepo, uc } = makeHarness({ failNthWith429: 1 });
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 8, contactPhone: '+5491123456789' });

      await expect(uc.execute(conv.id, 'HX1', { '1': 'Juan', '2': '$5.000' })).rejects.toBeInstanceOf(
        TemplateProviderUnavailableError,
      );
      expect(await messageRepo.listByConversation(conv.id)).toHaveLength(0);
    });
  });

  describe('TS-6 — proyección al hilo + bump post-OK', () => {
    it('happy path completo: args exactos a sendTemplate, fila proyectada con renderTemplateBody, bump de preview, DTO devuelto', async () => {
      const { conversationRepo, messageRepo, templatePort, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 9, contactPhone: '+5491123456789' });

      const dto = await uc.execute(conv.id, 'HX1', { '1': 'Juan', '2': '$5.000' }, 'agente1');

      expect(templatePort.calls).toEqual([
        { to: '+5491123456789', contentSid: 'HX1', variables: { '1': 'Juan', '2': '$5.000' } },
      ]);

      const messages = await messageRepo.listByConversation(conv.id);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          origin: 'agent_template',
          direction: 'outbound',
          content: 'Hola Juan, debés $5.000',
          chatwootMessageId: null,
          providerMessageId: expect.stringMatching(/^SMfake/),
          senderName: 'agente1',
        }),
      );

      const updatedConv = await conversationRepo.findById(conv.id);
      expect(updatedConv!.lastMessagePreview).toBe('Hola Juan, debés $5.000');

      expect(dto).toEqual(
        expect.objectContaining({
          direction: 'outbound',
          content: 'Hola Juan, debés $5.000',
          senderName: 'agente1',
        }),
      );
      expect(dto.sentAt).toBe(updatedConv!.lastMessageAt);
    });

    it('el envío NO abre la ventana — canReply sigue false y status intacto (regla de plataforma D2)', async () => {
      const { conversationRepo, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({
        chatwootConversationId: 10,
        contactPhone: '+5491123456789',
        canReply: false,
        status: 'open',
      });

      await uc.execute(conv.id, 'HX1', { '1': 'Juan', '2': '$5.000' });

      const updated = await conversationRepo.findById(conv.id);
      expect(updated!.canReply).toBe(false);
      expect(updated!.status).toBe('open');
    });

    it('enviable también DENTRO de ventana (canReply:true) — el use case NO valida canReply en ninguna dirección', async () => {
      const { conversationRepo, templatePort, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({
        chatwootConversationId: 11,
        contactPhone: '+5491123456789',
        canReply: true,
      });

      await expect(uc.execute(conv.id, 'HX1', { '1': 'Juan', '2': '$5.000' })).resolves.toBeDefined();
      expect(templatePort.calls).toHaveLength(1);
    });

    it('idempotencia del mirror por providerId — re-proyectar el mismo sid nunca duplica (defensa en profundidad del port ya probada; acá se verifica el pass-through)', async () => {
      const { conversationRepo, messageRepo, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 12, contactPhone: '+5491123456789' });

      await uc.execute(conv.id, 'HX1', { '1': 'Juan', '2': '$5.000' });
      const messages = await messageRepo.listByConversation(conv.id);

      expect(messages).toHaveLength(1);
      expect(messages[0]!.providerMessageId).toBeTruthy();
    });

    it('senderName ausente → pass-through null en la fila y el DTO', async () => {
      const { conversationRepo, messageRepo, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 13, contactPhone: '+5491123456789' });

      const dto = await uc.execute(conv.id, 'HX1', { '1': 'Juan', '2': '$5.000' });

      expect(dto.senderName).toBeNull();
      const messages = await messageRepo.listByConversation(conv.id);
      expect(messages[0]!.senderName).toBeNull();
    });
  });
});
