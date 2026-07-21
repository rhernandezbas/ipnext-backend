// randomUUID is non-configurable on the real `crypto` module (jest.spyOn can't
// redefine it) — mock the whole module, keeping every other export real, so the
// §8 tiebreaker test below can force a deterministic (and insertion-REVERSED) id
// sequence.
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn(jest.requireActual('crypto').randomUUID),
}));

import * as crypto from 'crypto';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { UpsertChatMessageInput, UpsertTemplateChatMessageInput } from '@domain/ports/ChatMessageRepository';

const mockRandomUUID = crypto.randomUUID as unknown as jest.Mock;

function input(overrides: Partial<UpsertChatMessageInput> = {}): UpsertChatMessageInput {
  return {
    conversationId: 'conv-1',
    chatwootMessageId: 100,
    direction: 'inbound',
    content: 'hola',
    chatwootCreatedAt: '2026-07-10T10:00:00.000Z',
    ...overrides,
  };
}

function templateInput(overrides: Partial<UpsertTemplateChatMessageInput> = {}): UpsertTemplateChatMessageInput {
  return {
    conversationId: 'conv-1',
    providerMessageId: 'SM123',
    content: 'Hola Juan, debés $5.000',
    chatwootCreatedAt: '2026-07-16T10:00:00.000Z',
    ...overrides,
  };
}

describe('InMemoryChatMessageRepository', () => {
  let repo: InMemoryChatMessageRepository;

  beforeEach(() => {
    repo = new InMemoryChatMessageRepository();
  });

  it('upsertByChatwootMessageId creates a new message', async () => {
    const created = await repo.upsertByChatwootMessageId(input());

    expect(created.conversationId).toBe('conv-1');
    expect(created.chatwootMessageId).toBe(100);
    expect(created.direction).toBe('inbound');
    expect(created.content).toBe('hola');
    expect(created.chatwootCreatedAt).toBe('2026-07-10T10:00:00.000Z');
    expect(created.id).toBeTruthy();
  });

  it('upsertByChatwootMessageId is idempotent — same chatwootMessageId does NOT duplicate (HOOK-4)', async () => {
    await repo.upsertByChatwootMessageId(input());
    await repo.upsertByChatwootMessageId(input({ content: 'hola (edit)' }));

    const messages = await repo.listByConversation('conv-1');

    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('hola (edit)');
  });

  it('listByConversation orders messages ASC by chatwootCreatedAt (INBOX-3)', async () => {
    await repo.upsertByChatwootMessageId(
      input({ chatwootMessageId: 2, chatwootCreatedAt: '2026-07-10T12:00:00.000Z', content: 'segundo' }),
    );
    await repo.upsertByChatwootMessageId(
      input({ chatwootMessageId: 1, chatwootCreatedAt: '2026-07-10T10:00:00.000Z', content: 'primero' }),
    );
    await repo.upsertByChatwootMessageId(
      input({ chatwootMessageId: 3, chatwootCreatedAt: '2026-07-10T14:00:00.000Z', content: 'tercero' }),
    );

    const messages = await repo.listByConversation('conv-1');

    expect(messages.map((m) => m.content)).toEqual(['primero', 'segundo', 'tercero']);
  });

  it('listByConversation only returns messages for the given conversation', async () => {
    await repo.upsertByChatwootMessageId(input({ conversationId: 'conv-1', chatwootMessageId: 1 }));
    await repo.upsertByChatwootMessageId(input({ conversationId: 'conv-2', chatwootMessageId: 2 }));

    const messages = await repo.listByConversation('conv-1');

    expect(messages).toHaveLength(1);
    expect(messages[0]!.conversationId).toBe('conv-1');
  });

  it('listByConversation returns an empty array for a conversation without messages (INBOX-3)', async () => {
    const messages = await repo.listByConversation('conv-empty');

    expect(messages).toEqual([]);
  });

  describe('messaging-inbox-notes (F1.5 fase D, NOTE-1) — isPrivate', () => {
    it('upsert con isPrivate:true lo persiste marcado', async () => {
      const created = await repo.upsertByChatwootMessageId(input({ isPrivate: true }));

      expect(created.isPrivate).toBe(true);
    });

    it('upsert sin isPrivate explícito → queda isPrivate:false por default', async () => {
      const created = await repo.upsertByChatwootMessageId(input());

      expect(created.isPrivate).toBe(false);
    });

    it('un re-upsert (mismo chatwootMessageId) actualiza isPrivate igual que el resto de los campos', async () => {
      await repo.upsertByChatwootMessageId(input({ isPrivate: false }));
      const updated = await repo.upsertByChatwootMessageId(input({ isPrivate: true }));

      expect(updated.isPrivate).toBe(true);
    });
  });

  describe('inbox-template-send (PORT-1) — upsertTemplateMessage', () => {
    it('crea la fila con el shape correcto (origin agent_template, outbound, sin chatwootMessageId/campaignRecipientId)', async () => {
      const created = await repo.upsertTemplateMessage(templateInput());

      expect(created.origin).toBe('agent_template');
      expect(created.direction).toBe('outbound');
      expect(created.chatwootMessageId).toBeNull();
      expect(created.campaignRecipientId).toBeNull();
      expect(created.isPrivate).toBe(false);
      expect(created.providerMessageId).toBe('SM123');
      expect(created.content).toBe('Hola Juan, debés $5.000');
      expect(created.id).toBeTruthy();
    });

    it('es idempotente por providerMessageId — re-ejecutar con el mismo sid NO duplica', async () => {
      await repo.upsertTemplateMessage(templateInput());
      await repo.upsertTemplateMessage(templateInput({ content: 're-proyectado' }));

      const messages = await repo.listByConversation('conv-1');

      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe('re-proyectado');
    });

    it('la fila proyectada aparece en listByConversation ordenada junto a mensajes chatwoot previos (origin-agnóstico)', async () => {
      await repo.upsertByChatwootMessageId(
        input({ chatwootMessageId: 1, chatwootCreatedAt: '2026-07-16T09:00:00.000Z', content: 'previo' }),
      );
      await repo.upsertTemplateMessage(templateInput({ chatwootCreatedAt: '2026-07-16T10:00:00.000Z' }));

      const messages = await repo.listByConversation('conv-1');

      expect(messages.map((m) => m.content)).toEqual(['previo', 'Hola Juan, debés $5.000']);
    });

    it('senderName ausente → null (pass-through cuando presente)', async () => {
      const withoutSender = await repo.upsertTemplateMessage(templateInput());
      expect(withoutSender.senderName).toBeNull();

      const withSender = await repo.upsertTemplateMessage(
        templateInput({ providerMessageId: 'SM999', senderName: 'agente1' }),
      );
      expect(withSender.senderName).toBe('agente1');
    });
  });

  describe('H1 (fix wave, idempotency-key server-side) — idempotencyKey + findByIdempotencyKey', () => {
    it('upsertTemplateMessage persiste el idempotencyKey recibido', async () => {
      const created = await repo.upsertTemplateMessage(templateInput({ idempotencyKey: 'idem-1' }));
      expect(created.idempotencyKey).toBe('idem-1');
    });

    it('idempotencyKey ausente → queda null (comportamiento actual, FE viejo sin key)', async () => {
      const created = await repo.upsertTemplateMessage(templateInput());
      expect(created.idempotencyKey).toBeNull();
    });

    it('findByIdempotencyKey resuelve la fila ya proyectada', async () => {
      await repo.upsertTemplateMessage(templateInput({ idempotencyKey: 'idem-2' }));

      const found = await repo.findByIdempotencyKey('idem-2');

      expect(found?.content).toBe('Hola Juan, debés $5.000');
    });

    it('findByIdempotencyKey sin match → null', async () => {
      expect(await repo.findByIdempotencyKey('nope')).toBeNull();
    });

    it('backstop de carrera: dos providerMessageId DISTINTOS (dos sends reales concurrentes) con la MISMA idempotencyKey → la segunda create recupera la fila GANADORA (la primera), no duplica ni pisa', async () => {
      const first = await repo.upsertTemplateMessage(
        templateInput({ providerMessageId: 'SM-race-A', idempotencyKey: 'idem-race' }),
      );

      const second = await repo.upsertTemplateMessage(
        templateInput({
          providerMessageId: 'SM-race-B',
          idempotencyKey: 'idem-race',
          content: 'segundo intento (perdedor de la carrera)',
        }),
      );

      expect(second.id).toBe(first.id);
      expect(second.providerMessageId).toBe('SM-race-A');
      expect(second.content).toBe('Hola Juan, debés $5.000');
      const all = await repo.listByConversation('conv-1');
      expect(all).toHaveLength(1);
    });
  });

  describe('chatwoot-hub-sendpath (D5) — idempotencyKey SET-ONCE en upsertByChatwootMessageId', () => {
    it('create con idempotencyKey → columna poblada', async () => {
      const created = await repo.upsertByChatwootMessageId(input({ chatwootMessageId: 555, idempotencyKey: 'idem-x' }));

      expect(created.idempotencyKey).toBe('idem-x');
    });

    it('idempotencyKey ausente en el create → queda null (webhook/GetConversation, que nunca la conocen)', async () => {
      const created = await repo.upsertByChatwootMessageId(input({ chatwootMessageId: 556 }));

      expect(created.idempotencyKey).toBeNull();
    });

    it('update idempotente del MISMO chatwootMessageId SIN key (simulando el eco del webhook) → la key original persiste intacta', async () => {
      await repo.upsertByChatwootMessageId(input({ chatwootMessageId: 557, idempotencyKey: 'idem-y' }));

      const updated = await repo.upsertByChatwootMessageId(
        input({ chatwootMessageId: 557, content: 'echo del webhook (sin idempotencyKey)' }),
      );

      expect(updated.idempotencyKey).toBe('idem-y');
      expect(updated.content).toBe('echo del webhook (sin idempotencyKey)');
    });
  });

  describe('messaging-inbox-notes (edit/delete) — content local vs re-espejo de Chatwoot (HIGH)', () => {
    it('una nota EDITADA localmente (editedAt != null) NO es pisada por un re-upsert con el content viejo de Chatwoot', async () => {
      // crea la nota (mirror del envío) con el content original
      const note = await repo.upsertByChatwootMessageId(input({ chatwootMessageId: 1, isPrivate: true, content: 'hello' }));
      // la editamos localmente (fuente de verdad LOCAL — Chatwoot no manda ediciones)
      await repo.updateContent(note.id, 'goodbye', '2026-07-20T00:00:00.000Z');

      // GetConversation.syncFromChatwoot re-espeja TODOS los mensajes con el content
      // ORIGINAL de Chatwoot en CADA apertura → esto NO debe revertir la edición.
      await repo.upsertByChatwootMessageId(input({ chatwootMessageId: 1, isPrivate: true, content: 'hello' }));

      const stored = await repo.findById(note.id);
      expect(stored!.content).toBe('goodbye'); // sobrevive
      expect(stored!.editedAt).toBe('2026-07-20T00:00:00.000Z'); // intacto
    });

    it('control: un mensaje NO editado (editedAt == null) SÍ refleja el nuevo content en el re-upsert', async () => {
      const msg = await repo.upsertByChatwootMessageId(input({ chatwootMessageId: 2, content: 'v1' }));
      await repo.upsertByChatwootMessageId(input({ chatwootMessageId: 2, content: 'v2 (edición de Chatwoot)' }));

      const stored = await repo.findById(msg.id);
      expect(stored!.content).toBe('v2 (edición de Chatwoot)');
    });
  });

  describe('messaging-inbox-notes (edit/delete) — updateContent/softDelete contrato null (LOW-3)', () => {
    it('updateContent sobre un id inexistente → null (no throw)', async () => {
      expect(await repo.updateContent('ghost', 'x', '2026-07-20T00:00:00.000Z')).toBeNull();
    });

    it('softDelete sobre un id inexistente → null (no throw)', async () => {
      expect(await repo.softDelete('ghost', '2026-07-20T00:00:00.000Z')).toBeNull();
    });
  });

  describe('chatwoot-hub-sendpath (B5, CHW-5) — markDeliveryFailedByChatwootMessageId', () => {
    it('fila existente → deliveryStatus=failed + deliveryError seteados, resto intacto', async () => {
      const created = await repo.upsertByChatwootMessageId(input({ chatwootMessageId: 900, content: 'Hola, debés $5.000' }));

      const updated = await repo.markDeliveryFailedByChatwootMessageId(900, 'Template not found');

      expect(updated).not.toBeNull();
      expect(updated!.deliveryStatus).toBe('failed');
      expect(updated!.deliveryError).toBe('Template not found');
      // resto intacto (mismo id/content/conversationId que antes)
      expect(updated!.id).toBe(created.id);
      expect(updated!.content).toBe('Hola, debés $5.000');
      expect(updated!.conversationId).toBe('conv-1');
    });

    it('fila ausente → retorna null, CERO error', async () => {
      const result = await repo.markDeliveryFailedByChatwootMessageId(99999, 'Template not found');

      expect(result).toBeNull();
    });

    it('llamada repetida (mismo id) es idempotente — sin duplicar filas ni pisar otros campos', async () => {
      await repo.upsertByChatwootMessageId(input({ chatwootMessageId: 901, senderName: 'agente1' }));

      await repo.markDeliveryFailedByChatwootMessageId(901, 'primer error');
      const second = await repo.markDeliveryFailedByChatwootMessageId(901, 'segundo error (retry del webhook)');

      expect(second!.deliveryStatus).toBe('failed');
      expect(second!.deliveryError).toBe('segundo error (retry del webhook)');
      expect(second!.senderName).toBe('agente1'); // no tocado

      const all = await repo.listByConversation('conv-1');
      expect(all.filter((m) => m.chatwootMessageId === 901)).toHaveLength(1); // no duplica
    });
  });

  describe('§8 — tiebreaker determinístico en empates de chatwootCreatedAt (in-memory DEBE ordenar igual que Prisma)', () => {
    it('dos mensajes con el MISMO chatwootCreatedAt se ordenan por id ASC, no por orden de insercion', async () => {
      // Same rationale as InMemoryConversationRepository's §8 test: Postgres gives
      // NO guarantee on tie order without a secondary ORDER BY key, unlike JS's
      // stable Array.prototype.sort (which would just preserve insertion order and
      // mask the missing tiebreaker). Force the generated id sequence to be the
      // REVERSE of insertion order — only an explicit id ASC tiebreaker can make
      // the assertion below pass.
      mockRandomUUID.mockReturnValueOnce('bbbbbbbb-0000-0000-0000-000000000000');
      mockRandomUUID.mockReturnValueOnce('aaaaaaaa-0000-0000-0000-000000000000');

      const same = '2026-07-10T10:00:00.000Z';
      await repo.upsertByChatwootMessageId(input({ chatwootMessageId: 1, chatwootCreatedAt: same, content: 'primero-insertado' }));
      await repo.upsertByChatwootMessageId(input({ chatwootMessageId: 2, chatwootCreatedAt: same, content: 'segundo-insertado' }));

      const messages = await repo.listByConversation('conv-1');

      expect(messages.map((m) => m.content)).toEqual(['segundo-insertado', 'primero-insertado']);
    });
  });
});
