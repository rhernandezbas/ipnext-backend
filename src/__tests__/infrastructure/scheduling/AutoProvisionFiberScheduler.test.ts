/**
 * AutoProvisionFiberScheduler — TDD tests (K3 fiber-auto-watcher).
 * Molde EXACTO de RadiusAutoCureScheduler.test.ts: flag DARK by default, chequeo POR TICK,
 * reentrancy intra-proceso, DistributedLock cross-replica, catch propio del tick, release
 * del lock, intervalo defensivo.
 *
 * Flag NUEVO 'fiber-auto-provision-watcher' — SEPARADO del flag del wizard
 * ('fiber-auto-provision'): prender el botón manual NO prende el watcher, y viceversa.
 */
import { AutoProvisionFiberScheduler } from '@infrastructure/scheduling/AutoProvisionFiberScheduler';
import type { AutoProvisionFiberOnusSummary } from '@application/use-cases/AutoProvisionFiberOnus';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { parseIntervalMs } from '@infrastructure/parseIntervalMs';

const FLAG_KEY = 'fiber-auto-provision-watcher';
const LOCK_KEY = 'fiber-auto-provision-watcher';

const ZERO_SUMMARY: AutoProvisionFiberOnusSummary = {
  candidates: 0, unconfigured: 0, matched: 0, provisioned: 0, failed: 0, skipped: 0,
};

/** Stub del use case: el scheduler solo necesita run(). */
class StubWatcher {
  calls = 0;
  failNext = false;
  async run(): Promise<AutoProvisionFiberOnusSummary> {
    this.calls++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('smartolt caido');
    }
    return { ...ZERO_SUMMARY };
  }
}

function makeHarness(flagEnabled?: boolean) {
  const watcher = new StubWatcher();
  const flags = new InMemoryFeatureFlagRepository();
  if (flagEnabled !== undefined) flags.seed(FLAG_KEY, flagEnabled);
  const lock = new InMemoryDistributedLock();
  const scheduler = new AutoProvisionFiberScheduler(watcher, { intervalMs: 1000, silent: true }, lock, flags);
  return { scheduler, watcher, flags, lock };
}

describe('AutoProvisionFiberScheduler', () => {
  it('flag OFF → el tick retorna sin trabajo (dark by default, NO toca nada)', async () => {
    const { scheduler, watcher } = makeHarness(false);
    const summary = await scheduler.runOnce();
    expect(watcher.calls).toBe(0);
    expect(summary.skipped).toBe(true);
  });

  it('flag AUSENTE (sin seed) → dark by default, tick no-op', async () => {
    const { scheduler, watcher } = makeHarness(undefined);
    const summary = await scheduler.runOnce();
    expect(watcher.calls).toBe(0);
    expect(summary.skipped).toBe(true);
  });

  it('el flag del WIZARD prendido NO prende el watcher (flags separados)', async () => {
    const { scheduler, watcher, flags } = makeHarness(undefined);
    flags.seed('fiber-auto-provision', true); // el flag del K2 (botón manual)
    const summary = await scheduler.runOnce();
    expect(watcher.calls).toBe(0);
    expect(summary.skipped).toBe(true);
  });

  it('flag ON → el tick procesa y devuelve el resumen del run (counters)', async () => {
    const { scheduler } = makeHarness(true);
    const summary = await scheduler.runOnce();
    expect(summary.skipped).toBeUndefined();
    expect(summary.result).toEqual(ZERO_SUMMARY);
  });

  it('ON → procesa; vuelto a OFF → el tick siguiente NO procesa (sin restart, chequeo POR tick)', async () => {
    const { scheduler, watcher, flags } = makeHarness(true);

    const first = await scheduler.runOnce();
    expect(first.result).toBeDefined();
    expect(watcher.calls).toBe(1);

    await flags.setEnabled(FLAG_KEY, false);
    const second = await scheduler.runOnce();
    expect(second.skipped).toBe(true);
    expect(watcher.calls).toBe(1);
  });

  it('reentrancy (overlap-guard): tick anterior en vuelo → skip', async () => {
    const { scheduler } = makeHarness(true);
    const [a, b] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    const skipped = [a, b].filter((r) => r.skipped).length;
    expect(skipped).toBe(1);
  });

  it('lock tomado por otra réplica → skip', async () => {
    const { scheduler, lock, watcher } = makeHarness(true);
    lock.forceAcquireFails = true;
    const summary = await scheduler.runOnce();
    expect(watcher.calls).toBe(0);
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
    watcher.failNext = true;
    const summary = await scheduler.runOnce();
    expect(summary.error).toContain('smartolt caido');
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

describe('FIBER_AUTO_PROVISION_INTERVAL_MS — contrato del intervalo', () => {
  const OPTS = { default: 300_000, min: 60_000, max: 86_400_000 };

  it('valor inválido → default 5 min (parseIntervalMs nunca lanza)', () => {
    expect(parseIntervalMs('garbage', OPTS)).toBe(300_000);
  });

  it('debajo del piso → clamp a 60s (rate limit SmartOLT); encima del techo → clamp a 24h', () => {
    expect(parseIntervalMs('1000', OPTS)).toBe(60_000);
    expect(parseIntervalMs('999999999999', OPTS)).toBe(86_400_000);
  });
});
