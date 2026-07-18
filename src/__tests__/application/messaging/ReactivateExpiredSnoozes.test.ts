/**
 * conversation-snooze (Ola 6c) — ReactivateExpiredSnoozes: núcleo del watcher (opción a).
 * Normaliza en DB las conversaciones snoozed cuyo `snoozedUntil` YA venció (<= now):
 * status='open', snoozedUntil=null, evento 'unsnoozed' (best-effort). Las VIGENTES
 * (snoozedUntil > now) NO se tocan. Idempotente: una conversación ya reactivada no vuelve a
 * contar. Corre bajo el `SnoozeReactivationScheduler` (lock + flag), acá se testea el core puro.
 */
import { ReactivateExpiredSnoozes } from '@application/use-cases/messaging/ReactivateExpiredSnoozes';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryConversationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationEventRepository';

function futureIso(msFromNow = 60 * 60 * 1000): string {
  return new Date(Date.now() + msFromNow).toISOString();
}
function pastIso(msAgo = 60 * 60 * 1000): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function makeHarness() {
  const conversationRepo = new InMemoryConversationRepository();
  const eventRepo = new InMemoryConversationEventRepository();
  const uc = new ReactivateExpiredSnoozes(conversationRepo, eventRepo);
  return { conversationRepo, eventRepo, uc };
}

/** Snooze directo sobre el mirror (sin pasar por la use case ni Chatwoot). */
async function seedSnoozed(repo: InMemoryConversationRepository, chatwootConversationId: number, snoozedUntil: string) {
  return repo.upsertByChatwootId({ chatwootConversationId, status: 'snoozed', snoozedUntil });
}

describe('ReactivateExpiredSnoozes', () => {
  it('snoozed VENCIDA → status="open", snoozedUntil=null, evento "unsnoozed"', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    const conv = await seedSnoozed(conversationRepo, 400, pastIso());

    const summary = await uc.run();

    expect(summary).toMatchObject({ candidates: 1, reactivated: 1, failed: 0 });
    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.status).toBe('open');
    expect(updated!.snoozedUntil).toBeNull();

    const events = await eventRepo.listByConversation(conv.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'unsnoozed', actorId: null, fromValue: 'snoozed', toValue: 'open' });
  });

  it('snoozed VIGENTE (snoozedUntil > now) → NO se toca', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    const conv = await seedSnoozed(conversationRepo, 401, futureIso());

    const summary = await uc.run();

    expect(summary).toMatchObject({ candidates: 0, reactivated: 0 });
    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.status).toBe('snoozed');
    expect(updated!.snoozedUntil).not.toBeNull();
    expect(await eventRepo.listByConversation(conv.id)).toHaveLength(0);
  });

  it('conversaciones NO snoozed (open/resolved/pending) → NUNCA se tocan', async () => {
    const { conversationRepo, uc } = makeHarness();
    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 402, status: 'open' });
    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 403, status: 'resolved' });
    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 404, status: 'pending' });

    const summary = await uc.run();

    expect(summary).toMatchObject({ candidates: 0, reactivated: 0 });
  });

  it('mezcla: reactiva SOLO las vencidas, deja las vigentes intactas', async () => {
    const { conversationRepo, uc } = makeHarness();
    const vencida1 = await seedSnoozed(conversationRepo, 410, pastIso());
    const vencida2 = await seedSnoozed(conversationRepo, 411, pastIso(5000));
    const vigente = await seedSnoozed(conversationRepo, 412, futureIso());

    const summary = await uc.run();

    expect(summary).toMatchObject({ candidates: 2, reactivated: 2 });
    expect((await conversationRepo.findById(vencida1.id))!.status).toBe('open');
    expect((await conversationRepo.findById(vencida2.id))!.status).toBe('open');
    expect((await conversationRepo.findById(vigente.id))!.status).toBe('snoozed');
  });

  it('idempotente: un segundo run no encuentra candidatos (ya reactivadas)', async () => {
    const { conversationRepo, uc } = makeHarness();
    await seedSnoozed(conversationRepo, 420, pastIso());

    const first = await uc.run();
    expect(first.reactivated).toBe(1);

    const second = await uc.run();
    expect(second).toMatchObject({ candidates: 0, reactivated: 0 });
  });

  it('best-effort: un fallo al registrar el evento NO impide reactivar el status', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    eventRepo.failRecord = true;
    const conv = await seedSnoozed(conversationRepo, 430, pastIso());

    const summary = await uc.run();

    expect(summary.reactivated).toBe(1);
    expect((await conversationRepo.findById(conv.id))!.status).toBe('open'); // reactivado igual
    expect(await eventRepo.listByConversation(conv.id)).toHaveLength(0); // evento perdido
  });
});
