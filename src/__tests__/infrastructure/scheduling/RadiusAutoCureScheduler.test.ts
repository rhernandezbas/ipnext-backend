/**
 * RadiusAutoCureScheduler — TDD tests (radius-session-autocure BE-1, REQ-CURE-4/7).
 * Molde EXACTO de PppoeAutoMoveScheduler.test.ts: flag DARK by default (S4.4/S7.1), reentrancy,
 * lock cross-replica, catch propio del tick, release del lock, intervalo defensivo (S7.2).
 */
import { RadiusAutoCureScheduler } from '@infrastructure/scheduling/RadiusAutoCureScheduler';
import { AutoCureStuckSessions } from '@application/use-cases/AutoCureStuckSessions';
import { CureStuckSession } from '@application/use-cases/CureStuckSession';
import { InMemoryRadiusAuthEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusAuthEventRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRadiusSessionCureEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusSessionCureEventRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { parseIntervalMs } from '@infrastructure/parseIntervalMs';

const FLAG_KEY = 'radius-auto-cure';
const LOCK_KEY = 'radius-auto-cure';
const TUNING = { lookbackMs: 900_000, abortThreshold: 20, maxPerTick: 5, cooldownMs: 1_800_000, flappingMax: 3 };
const CURE_TUNING = { staleMs: 1_200_000, persistenceMs: 300_000, recencyMs: 120_000 };

function makeHarness(flagEnabled?: boolean) {
  const authRepo = new InMemoryRadiusAuthEventRepository();
  const cureEventRepo = new InMemoryRadiusSessionCureEventRepository();
  const gateway = new InMemoryRadiusOrchestratorGateway({});
  const cureStuckSession = new CureStuckSession(gateway, cureEventRepo, CURE_TUNING);
  const watcher = new AutoCureStuckSessions(authRepo, cureEventRepo, cureStuckSession, TUNING);

  const flags = new InMemoryFeatureFlagRepository();
  if (flagEnabled !== undefined) flags.seed(FLAG_KEY, flagEnabled);
  const lock = new InMemoryDistributedLock();
  const scheduler = new RadiusAutoCureScheduler(watcher, { intervalMs: 1000, silent: true }, lock, flags);
  return { scheduler, watcher, flags, lock, authRepo };
}

describe('RadiusAutoCureScheduler', () => {
  it('S4.4/S7.1: flag OFF → el tick retorna sin trabajo (dark by default)', async () => {
    const { scheduler, watcher } = makeHarness(false);
    const spy = jest.spyOn(watcher, 'run');
    const summary = await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('S7.1: flag AUSENTE (sin seed) → dark by default, tick no-op', async () => {
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
    expect(summary.result).toEqual({
      events: 0, candidates: 0, cured: 0, alreadyCured: 0, failed: 0,
      skippedAlive: 0, skippedAmbiguous: 0, skippedNoSession: 0, skippedNoSignal: 0,
      skippedCureThrottle: 0, flaggedFlapping: 0, deferred: 0, throttled: 0, aborted: false,
    });
  });

  it('S4.4: ON → procesa; vuelto a OFF → el tick siguiente NO procesa (sin restart, chequeo POR tick)', async () => {
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
});

describe('RADIUS_AUTO_CURE_INTERVAL_MS — contrato del intervalo (S7.2)', () => {
  const OPTS = { default: 60_000, min: 15_000, max: 86_400_000 };

  it('valor inválido → default 1 min (parseIntervalMs nunca lanza)', () => {
    expect(parseIntervalMs('garbage', OPTS)).toBe(60_000);
  });

  it('debajo del piso → clamp a 15s; encima del techo → clamp a 24h', () => {
    expect(parseIntervalMs('1000', OPTS)).toBe(15_000);
    expect(parseIntervalMs('999999999999', OPTS)).toBe(86_400_000);
  });
});
