/**
 * whatsapp-invoice-detail-quickreply (Phase 6, QR-1/QR-4) — wiring del quick-
 * reply de detalle de facturas en `ReceiveChatwootWebhook`. Mismo molde EXACTO
 * que `ReceiveChatwootWebhook.optout.test.ts` (OPT-2): archivo nuevo, nuevo
 * parámetro OPCIONAL al FINAL del constructor, fail-open, cero regresión sobre
 * los call-sites existentes (3/5/6/7/8-arg).
 */
import { ReceiveChatwootWebhook } from '@application/use-cases/messaging/ReceiveChatwootWebhook';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryWebhookDeliveryRepository } from '@infrastructure/adapters/in-memory/InMemoryWebhookDeliveryRepository';
import type { ReplyWithInvoiceDetailInput } from '@application/use-cases/messaging/invoice-detail/ReplyWithInvoiceDetail';

function fakeReplier(opts: { throwOnExecute?: boolean } = {}) {
  const calls: ReplyWithInvoiceDetailInput[] = [];
  const replier = {
    async execute(input: ReplyWithInvoiceDetailInput): Promise<void> {
      calls.push(input);
      if (opts.throwOnExecute) throw new Error('collaborator hiccup');
    },
  };
  return { replier, calls };
}

function makeUseCase(replier?: { execute(input: ReplyWithInvoiceDetailInput): Promise<void> }) {
  const conversationRepo = new InMemoryConversationRepository();
  const messageRepo = new InMemoryChatMessageRepository();
  const deliveryRepo = new InMemoryWebhookDeliveryRepository();
  // 9º arg: undefined en attachmentRepo/downloadTrigger/optOutSource/eventRepo/assistant
  // (posiciones 4-8) — el nuevo colaborador es el ÚLTIMO parámetro, backward-compat total.
  const uc = new ReceiveChatwootWebhook(
    conversationRepo,
    messageRepo,
    deliveryRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    replier,
  );
  return { uc, conversationRepo, messageRepo, deliveryRepo };
}

function inboundPayload(content: string, phone: string | null, id = 900, conversationId = 77) {
  return {
    event: 'message_created',
    id,
    content,
    message_type: 'incoming',
    created_at: 1735689600,
    conversation: { id: conversationId, meta: { sender: { name: 'Cliente Test', phone_number: phone } } },
    sender: { name: 'Cliente Test' },
  };
}

describe('ReceiveChatwootWebhook — invoice-detail quick-reply wiring (Phase 6)', () => {
  it('tap inbound del botón → invoca al colaborador con content/phone/chatwootConversationId', async () => {
    const { replier, calls } = fakeReplier();
    const { uc } = makeUseCase(replier);

    await uc.execute('d-1', inboundPayload('Ver mis facturas', '+5492324421234', 900, 77));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ content: 'Ver mis facturas', phone: '+5492324421234', chatwootConversationId: 77 });
  });

  it('contenido no relacionado → el colaborador NO se invoca por otra vía… (el colaborador SÍ recibe la llamada, decide él)', async () => {
    // El webhook delega la decisión de trigger al colaborador (misma separación de
    // responsabilidades que `ReplyWithInvoiceDetail`, que YA decide "no dispara" para
    // contenido no relacionado); acá solo se prueba que el webhook lo invoca siempre
    // que hay un inbound, pase lo que pase adentro.
    const { replier, calls } = fakeReplier();
    const { uc } = makeUseCase(replier);

    await uc.execute('d-2', inboundPayload('Hola, tengo una duda', '+5492324421234', 901, 77));

    expect(calls).toHaveLength(1);
    expect(calls[0].content).toBe('Hola, tengo una duda');
  });

  it('mensaje OUTBOUND → el colaborador NUNCA se invoca (solo taps inbound cuentan, QR-1)', async () => {
    const { replier, calls } = fakeReplier();
    const { uc } = makeUseCase(replier);
    const payload = { ...inboundPayload('Ver mis facturas', '+5492324421234'), message_type: 'outgoing' };

    await uc.execute('d-3', payload);

    expect(calls).toHaveLength(0);
  });

  it('el colaborador lanza (hipo) → el webhook NO explota e IGUAL espeja el mensaje y ackea (fail-open)', async () => {
    const { replier } = fakeReplier({ throwOnExecute: true });
    const { uc, conversationRepo, messageRepo, deliveryRepo } = makeUseCase(replier);

    await expect(uc.execute('d-4', inboundPayload('Ver mis facturas', '+5492324421234', 902, 77))).resolves.not.toThrow();

    const conv = await conversationRepo.findByChatwootId(77);
    expect(conv).not.toBeNull();
    const messages = await messageRepo.listByConversation(conv!.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Ver mis facturas');
    expect(await deliveryRepo.hasSeen('chatwoot', 'd-4')).toBe(true);
  });

  it('sin colaborador inyectado (backward-compat, 3/5/6/7/8-arg existentes) — cero regresión', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const deliveryRepo = new InMemoryWebhookDeliveryRepository();
    const uc = new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo);

    await expect(uc.execute('d-5', inboundPayload('Ver mis facturas', '+5492324421234'))).resolves.not.toThrow();
  });
});
