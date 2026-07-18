/**
 * conversation-events (Ola 2) — GetReportsOverview: los "current" reusan GetInboxViewCounts +
 * un count exacto de 'pending'; los "inRange" cuentan eventos 'resolved' y conversaciones
 * creadas en el rango [from,to).
 */
import { GetReportsOverview } from '@application/use-cases/messaging/GetReportsOverview';
import { GetInboxViewCounts } from '@application/use-cases/messaging/GetInboxViewCounts';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryConversationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationEventRepository';

const WIDE_FROM = '2020-01-01T00:00:00.000Z';
const WIDE_TO = '2100-01-01T00:00:00.000Z';
const EMPTY_FROM = '2000-01-01T00:00:00.000Z';
const EMPTY_TO = '2001-01-01T00:00:00.000Z';

async function makeHarness() {
  const conversationRepo = new InMemoryConversationRepository();
  const eventRepo = new InMemoryConversationEventRepository();
  const getInboxViewCounts = new GetInboxViewCounts(conversationRepo);
  const uc = new GetReportsOverview(conversationRepo, eventRepo, getInboxViewCounts);

  // 3 no-resueltas (2 open + 1 pending) + 1 resuelta.
  const open1 = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 1, status: 'open' }); // unassigned + inbound
  conversationRepo.syncLastPublicMessageDirection(open1.id, 'inbound'); // → unattended
  const open2 = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 2, status: 'open' });
  await conversationRepo.updateLocalFields(open2.id, { assigneeId: 'user-1' }); // assigned
  await conversationRepo.upsertByChatwootId({ chatwootConversationId: 3, status: 'pending' }); // pending (unassigned)
  await conversationRepo.upsertByChatwootId({ chatwootConversationId: 4, status: 'resolved' }); // resolved

  return { conversationRepo, eventRepo, getInboxViewCounts, uc };
}

describe('GetReportsOverview — conversation-events (Ola 2)', () => {
  it('los "current" coinciden EXACTO con GetInboxViewCounts (+ currentPending exacto)', async () => {
    const { getInboxViewCounts, eventRepo, uc } = await makeHarness();
    eventRepo.seed([
      { conversationId: 'c', type: 'resolved', createdAt: '2026-07-15T12:00:00.000Z' },
      { conversationId: 'c', type: 'resolved', createdAt: '2026-07-16T12:00:00.000Z' },
    ]);

    const inbox = await getInboxViewCounts.execute('user-1');
    const overview = await uc.execute('user-1', WIDE_FROM, WIDE_TO);

    expect(overview.currentOpen).toBe(inbox.all); // 3
    expect(overview.currentUnattended).toBe(inbox.unattended); // 1
    expect(overview.currentUnassigned).toBe(inbox.unassigned); // 2 (open1 + pending)
    expect(overview.currentPending).toBe(1); // status === 'pending' exacto
    expect(overview.currentOpen).toBe(3);
    expect(overview.currentUnattended).toBe(1);
    expect(overview.currentUnassigned).toBe(2);
  });

  it('resolvedInRange cuenta eventos "resolved" en el rango; createdInRange cuenta conversaciones creadas en el rango', async () => {
    const { eventRepo, uc } = await makeHarness();
    eventRepo.seed([
      { conversationId: 'c', type: 'resolved', createdAt: '2026-07-15T12:00:00.000Z' }, // dentro
      { conversationId: 'c', type: 'resolved', createdAt: '2026-07-16T12:00:00.000Z' }, // dentro
      { conversationId: 'c', type: 'resolved', createdAt: '2019-01-01T12:00:00.000Z' }, // FUERA (pre-rango)
      { conversationId: 'c', type: 'reopened', createdAt: '2026-07-15T13:00:00.000Z' }, // no cuenta (otro type)
    ]);

    const overview = await uc.execute('user-1', WIDE_FROM, WIDE_TO);

    expect(overview.resolvedInRange).toBe(2);
    expect(overview.createdInRange).toBe(4); // las 4 conversaciones se crearon "ahora" (dentro del rango ancho)
  });

  it('rango vacío → resolvedInRange e createdInRange en 0 (los current siguen siendo el estado actual)', async () => {
    const { eventRepo, uc } = await makeHarness();
    eventRepo.seed([{ conversationId: 'c', type: 'resolved', createdAt: '2026-07-15T12:00:00.000Z' }]);

    const overview = await uc.execute('user-1', EMPTY_FROM, EMPTY_TO);

    expect(overview.resolvedInRange).toBe(0);
    expect(overview.createdInRange).toBe(0);
    expect(overview.currentOpen).toBe(3); // point-in-time, no depende del rango
    expect(overview.currentPending).toBe(1);
  });
});
