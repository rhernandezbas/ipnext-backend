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
