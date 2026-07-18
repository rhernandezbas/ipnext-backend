/**
 * SnoozeReactivationScheduler — TDD tests (conversation-snooze Ola 6c, watcher opción a).
 * Molde EXACTO de RadiusAutoCureScheduler.test.ts: flag DARK by default, reentrancy, lock
 * cross-replica, catch propio del tick, release del lock.
 */
import { SnoozeReactivationScheduler } from '@infrastructure/scheduling/SnoozeReactivationScheduler';
import { ReactivateExpiredSnoozes } from '@application/use-cases/messaging/ReactivateExpiredSnoozes';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryConversationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationEventRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';

const FLAG_KEY = 'snooze-reactivation';
const LOCK_KEY = 'snooze-reactivation';

function makeHarness(flagEnabled?: boolean) {
  const conversationRepo = new InMemoryConversationRepository();
  const eventRepo = new InMemoryConversationEventRepository();
  const watcher = new ReactivateExpiredSnoozes(conversationRepo, eventRepo);

  const flags = new InMemoryFeatureFlagRepository();
  if (flagEnabled !== undefined) flags.seed(FLAG_KEY, flagEnabled);
  const lock = new InMemoryDistributedLock();
  const scheduler = new SnoozeReactivationScheduler(watcher, { intervalMs: 1000, silent: true }, lock, flags);
  return { scheduler, watcher, flags, lock, conversationRepo };
}

describe('SnoozeReactivationScheduler', () => {
  it('flag OFF → el tick retorna sin trabajo (dark by default)', async () => {
    const { scheduler, watcher } = makeHarness(false);
    const spy = jest.spyOn(watcher, 'run');
    const summary = await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('flag AUSENTE (sin seed) → dark by default, tick no-op', async () => {
    const { scheduler, watcher } = makeHarness(undefined);
    const spy = jest.spyOn(watcher, 'run');
    const summary = await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('flag ON → el tick procesa y devuelve el resumen del run', async () => {
    const { scheduler } = makeHarness(true);
    const summary = await scheduler.runOnce();
    expect(summary.skipped).toBeUndefined();
    expect(summary.result).toEqual({ candidates: 0, reactivated: 0, failed: 0 });
  });

  it('ON → procesa; vuelto a OFF → el tick siguiente NO procesa (sin restart, chequeo POR tick)', async () => {
    const { scheduler, watcher, flags } = makeHarness(true);
    const spy = jest.spyOn(watcher, 'run');

    const first = await scheduler.runOnce();
    expect(first.result).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);

    await flags.setEnabled(FLAG_KEY, false);
    const second = await scheduler.runOnce();
    expect(second.skipped).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reentrancy: tick anterior en vuelo → skip', async () => {
    const { scheduler } = makeHarness(true);
    const [a, b] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    const skipped = [a, b].filter((r) => r.skipped).length;
    expect(skipped).toBe(1);
  });

  it('lock tomado por otra réplica → skip', async () => {
    const { scheduler, lock, watcher } = makeHarness(true);
    lock.forceAcquireFails = true;
    const spy = jest.spyOn(watcher, 'run');
    const summary = await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('catch propio del tick: flags.get lanza → runOnce NO rechaza, el tick siguiente corre', async () => {
    const { scheduler, flags } = makeHarness(true);
    jest.spyOn(flags, 'get').mockRejectedValueOnce(new Error('flag db down'));
    await expect(scheduler.runOnce()).resolves.toMatchObject({ error: expect.stringContaining('flag db down') });
    const next = await scheduler.runOnce();
    expect(next.result).toBeDefined();
  });

  it('best-effort: error del run no tira el scheduler (loguea y continúa)', async () => {
    const { scheduler, watcher } = makeHarness(true);
    jest.spyOn(watcher, 'run').mockRejectedValueOnce(new Error('db caida'));
    const summary = await scheduler.runOnce();
    expect(summary.error).toContain('db caida');
    const next = await scheduler.runOnce();
    expect(next.result).toBeDefined();
  });

  it('libera el lock después de cada run', async () => {
    const { scheduler, lock } = makeHarness(true);
    const releaseSpy = jest.spyOn(lock, 'release');
    await scheduler.runOnce();
    expect(releaseSpy).toHaveBeenCalledWith(LOCK_KEY);
    expect(lock.heldKeys.has(LOCK_KEY)).toBe(false);
  });

  it('flag ON con una snoozed vencida → la reactiva (integración con el core)', async () => {
    const { scheduler, conversationRepo } = makeHarness(true);
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 500,
      status: 'snoozed',
      snoozedUntil: new Date(Date.now() - 60_000).toISOString(),
    });

    const summary = await scheduler.runOnce();

    expect(summary.result).toMatchObject({ reactivated: 1 });
    expect((await conversationRepo.findById(conv.id))!.status).toBe('open');
  });
});
