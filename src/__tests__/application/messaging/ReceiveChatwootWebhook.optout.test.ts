/**
 * messaging-bulk (F2, Batch 6, T6.5, OPT-2) — detección de baja por keyword
 * (BAJA/STOP) en mensajes INBOUND de `ReceiveChatwootWebhook`. Complementa
 * `ReceiveChatwootWebhook.test.ts` (F1, batch B4) SIN tocarlo — nuevo archivo,
 * nuevo 6º parámetro OPCIONAL del constructor (`optOutSource`), cero regresión
 * sobre los call-sites existentes (3/5-arg, ver ese archivo y
 * `messaging.routes.test.ts`).
 *
 * tasks.md contradicción #4: resuelve el `Client` por teléfono contra
 * `listSegmentRecipients({statuses:[]})` (el escape hatch de T6.3) — NUNCA
 * `listActiveContacts()`, que excluiría justo al público del bulk
 * (late/blocked/baja). Fake ad-hoc (T3.3 pattern, no existe
 * InMemoryCustomerRepository en el repo): implementa `CampaignSegmentSource &
 * OptOutRegistry` con un `registerOptOut` primer-en-ganar (mismo contrato que
 * `PrismaCustomerRepository.registerOptOut`, OPT-1), lo que también ejercita
 * el contrato OPT-1 end-to-end (sin DB, ver nota en PrismaCustomerRepository.ts).
 */
import { ReceiveChatwootWebhook } from '@application/use-cases/messaging/ReceiveChatwootWebhook';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryWebhookDeliveryRepository } from '@infrastructure/adapters/in-memory/InMemoryWebhookDeliveryRepository';
import type { CampaignSegmentSource, CampaignRecipientCandidate, OptOutRegistry } from '@domain/ports/CustomerRepository';

interface FakeCandidateRow extends CampaignRecipientCandidate {}

function makeFakeOptOutSource(rows: FakeCandidateRow[]): CampaignSegmentSource & OptOutRegistry & { rows: FakeCandidateRow[] } {
  return {
    rows,
    async listSegmentRecipients() {
      // Escape hatch T6.3 (statuses:[]) — devuelve el universo COMPLETO, sin
      // filtrar por status ni por whatsappOptOutAt (mismo contrato Prisma real).
      return rows.map((r) => ({ ...r }));
    },
    async registerOptOut(clientId: string) {
      const row = rows.find((r) => r.clientId === clientId);
      // OPT-1 — primer-en-ganar: solo setea si estaba null, nunca pisa T1.
      if (row && row.whatsappOptOutAt == null) {
        row.whatsappOptOutAt = new Date().toISOString();
      }
    },
  };
}

function makeUseCase(optOutRows: FakeCandidateRow[] = []) {
  const conversationRepo = new InMemoryConversationRepository();
  const messageRepo = new InMemoryChatMessageRepository();
  const deliveryRepo = new InMemoryWebhookDeliveryRepository();
  const optOutSource = makeFakeOptOutSource(optOutRows);
  const uc = new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo, undefined, undefined, optOutSource);
  return { uc, conversationRepo, messageRepo, deliveryRepo, optOutSource };
}

function inboundPayload(content: string, phone: string | null, id = 900) {
  return {
    event: 'message_created',
    id,
    content,
    message_type: 'incoming',
    created_at: 1735689600,
    conversation: { id: 77, meta: { sender: { name: 'Cliente Test', phone_number: phone } } },
    sender: { name: 'Cliente Test' },
  };
}

describe('ReceiveChatwootWebhook — OPT-2 (detección BAJA/STOP inbound)', () => {
  it('mensaje inbound "BAJA" de un contacto matcheado → whatsappOptOutAt seteado', async () => {
    const { uc, optOutSource } = makeUseCase([
      { clientId: 'c-1', name: 'Juan', phone: '2324421234', balanceDue: 5000, whatsappOptOutAt: null },
    ]);

    await uc.execute('d-1', inboundPayload('BAJA', '+5492324421234'));

    expect(optOutSource.rows[0].whatsappOptOutAt).not.toBeNull();
  });

  it('variante "  stop  " (minúsculas + espacios) — case-insensitive y trim-tolerant', async () => {
    const { uc, optOutSource } = makeUseCase([
      { clientId: 'c-2', name: 'Ana', phone: '3364000000', balanceDue: null, whatsappOptOutAt: null },
    ]);

    await uc.execute('d-2', inboundPayload('  stop  ', '+5493364000000'));

    expect(optOutSource.rows[0].whatsappOptOutAt).not.toBeNull();
  });

  it('mensaje inbound sin la keyword → whatsappOptOutAt NO se modifica', async () => {
    const { uc, optOutSource } = makeUseCase([
      { clientId: 'c-3', name: 'Pedro', phone: '2324000001', balanceDue: 1000, whatsappOptOutAt: null },
    ]);

    await uc.execute('d-3', inboundPayload('Hola, tengo un problema con mi factura', '+5492324000001'));

    expect(optOutSource.rows[0].whatsappOptOutAt).toBeNull();
  });

  it('keyword "BAJA" de un teléfono SIN match a ningún Client → procesa sin error (no-op)', async () => {
    const { uc, optOutSource } = makeUseCase([
      { clientId: 'c-4', name: 'Otro', phone: '2324999999', balanceDue: 0, whatsappOptOutAt: null },
    ]);

    await expect(uc.execute('d-4', inboundPayload('BAJA', '+5491111111111'))).resolves.not.toThrow();
    expect(optOutSource.rows[0].whatsappOptOutAt).toBeNull();
  });

  it('OPT-1 idempotencia: repetir BAJA sobre un cliente YA opt-out (T1) NO pisa el timestamp original', async () => {
    const t1 = '2026-01-01T00:00:00.000Z';
    const { uc, optOutSource } = makeUseCase([
      { clientId: 'c-5', name: 'Ya Opt Out', phone: '2324555555', balanceDue: 0, whatsappOptOutAt: t1 },
    ]);

    await uc.execute('d-5', inboundPayload('BAJA', '+5492324555555'));

    expect(optOutSource.rows[0].whatsappOptOutAt).toBe(t1);
  });

  it('sin optOutSource inyectado (backward-compat, 3/5-arg existentes) — "BAJA" no rompe el webhook', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const deliveryRepo = new InMemoryWebhookDeliveryRepository();
    const uc = new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo);

    await expect(uc.execute('d-6', inboundPayload('BAJA', '+5492324421234'))).resolves.not.toThrow();
  });

  it('mensaje OUTBOUND con "BAJA" → NUNCA dispara opt-out (solo inbound aplica)', async () => {
    const { uc, optOutSource } = makeUseCase([
      { clientId: 'c-6', name: 'Cliente', phone: '2324421234', balanceDue: 0, whatsappOptOutAt: null },
    ]);
    const payload = {
      ...inboundPayload('BAJA', '+5492324421234'),
      message_type: 'outgoing',
    };

    await uc.execute('d-7', payload);

    expect(optOutSource.rows[0].whatsappOptOutAt).toBeNull();
  });

  // ── FIX-9: multi-match por sufijo daba de baja al cliente EQUIVOCADO ──────────
  it('FIX-9: dos clientes colisionan en el sufijo (últimos 8) pero solo UNO matchea exacto → SOLO ese queda opt-out', async () => {
    // c-a: área 2324 (número real del que mandó BAJA). c-b: área 11 (GBA), MISMOS
    // últimos 8 dígitos (24421234) por pura coincidencia — paga y NO pidió nada.
    const { uc, optOutSource } = makeUseCase([
      { clientId: 'c-a', name: 'Area 2324', phone: '2324421234', balanceDue: 5000, whatsappOptOutAt: null },
      { clientId: 'c-b', name: 'Area 11', phone: '1124421234', balanceDue: 8000, whatsappOptOutAt: null },
    ]);

    await uc.execute('d-fix9', inboundPayload('BAJA', '+5492324421234'));

    const a = optOutSource.rows.find((r) => r.clientId === 'c-a')!;
    const b = optOutSource.rows.find((r) => r.clientId === 'c-b')!;
    expect(a.whatsappOptOutAt).not.toBeNull(); // el que mandó BAJA
    expect(b.whatsappOptOutAt).toBeNull(); // NO dado de baja: distinto número, mismo sufijo
  });

  // ── FIX-10: registerOptOut sin try/catch perdía el "BAJA" ante hipo de DB ─────
  it('FIX-10: registerOptOut tira (hipo de DB) → el webhook NO explota e IGUAL espeja el mensaje (fail-open)', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const deliveryRepo = new InMemoryWebhookDeliveryRepository();
    const throwingSource: CampaignSegmentSource & OptOutRegistry = {
      async listSegmentRecipients(): Promise<CampaignRecipientCandidate[]> {
        return [{ clientId: 'c-1', name: 'Juan', phone: '2324421234', balanceDue: 5000, whatsappOptOutAt: null }];
      },
      async registerOptOut(): Promise<void> {
        throw new Error('DB hiccup en registerOptOut');
      },
    };
    const uc = new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo, undefined, undefined, throwingSource);

    await expect(uc.execute('d-fix10', inboundPayload('BAJA', '+5492324421234'))).resolves.not.toThrow();

    // el mensaje SIEMPRE se espeja aunque el opt-out falle (fail-open, docstring)
    const conv = await conversationRepo.findByChatwootId(77);
    expect(conv).not.toBeNull();
    const messages = await messageRepo.listByConversation(conv!.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('BAJA');
    // delivery registrado = process() completó sin propagar el throw
    expect(await deliveryRepo.hasSeen('chatwoot', 'd-fix10')).toBe(true);
  });

  // ── FIX-9-v2: opt-out IGNORADO para teléfonos con "15" móvil embebido ─────────
  // `normalizePhone` es LOSSY: NO strippea el "15" entre área y abonado, así que
  // un `Client.phone = "011 15-2345-6789"` normaliza distinto que el webhook
  // `+5491123456789` → el opt-out se ignoraba en SILENCIO (compliance: opt-out
  // ignorado = riesgo de baneo Meta). El match debe hacerse por `toWhatsAppE164`
  // (canonicaliza el "15" via el rewrite de Wave 1).
  it('FIX-9-v2: Client.phone con "15" embebido ("011 15-2345-6789") + webhook +5491123456789 → opt-out (NO ignorado)', async () => {
    const { uc, optOutSource } = makeUseCase([
      { clientId: 'c-15', name: 'Con 15 embebido', phone: '011 15-2345-6789', balanceDue: 5000, whatsappOptOutAt: null },
    ]);

    await uc.execute('d-fix9v2-a', inboundPayload('BAJA', '+5491123456789'));

    // Con `normalizePhone` (FIX-9 v1) este match se PERDÍA → whatsappOptOutAt null (regresión).
    expect(optOutSource.rows[0].whatsappOptOutAt).not.toBeNull();
  });

  it('FIX-9-v2: formato local "02324 15-421234" también matchea contra su E164', async () => {
    const { uc, optOutSource } = makeUseCase([
      { clientId: 'c-loc', name: 'Local con 15', phone: '02324 15-421234', balanceDue: 3000, whatsappOptOutAt: null },
    ]);

    await uc.execute('d-fix9v2-c', inboundPayload('BAJA', '+5492324421234'));

    expect(optOutSource.rows[0].whatsappOptOutAt).not.toBeNull();
  });

  it('FIX-9-v2: dos clientes colisionan en el sufijo (últimos 8) pero difieren en E164 → SOLO el correcto queda opt-out', async () => {
    // c-good: área 2324 guardado CON "15" embebido (el que mandó BAJA). c-bad:
    // área 11 (GBA), MISMOS últimos 8 (24421234) por coincidencia — paga y NO pidió
    // nada. `toWhatsAppE164` los distingue (áreas distintas → E164 distinto);
    // `suffixMatch` (viejo) daba de baja a AMBOS, y `normalizePhone` exacto (v1)
    // ni siquiera encontraba a c-good por el "15" embebido.
    const { uc, optOutSource } = makeUseCase([
      { clientId: 'c-good', name: 'Area 2324 con 15', phone: '2324 15-421234', balanceDue: 5000, whatsappOptOutAt: null },
      { clientId: 'c-bad', name: 'Area 11 mismo sufijo', phone: '1124421234', balanceDue: 8000, whatsappOptOutAt: null },
    ]);

    await uc.execute('d-fix9v2-b', inboundPayload('BAJA', '+5492324421234'));

    const good = optOutSource.rows.find((r) => r.clientId === 'c-good')!;
    const bad = optOutSource.rows.find((r) => r.clientId === 'c-bad')!;
    expect(good.whatsappOptOutAt).not.toBeNull(); // encontrado pese al "15" embebido
    expect(bad.whatsappOptOutAt).toBeNull(); // NO dado de baja: distinto E164, mismo sufijo
  });
});
