/**
 * PppoeAutoMoveScheduler — TDD tests (pppoe-move-nas W2, REQ-AUTO-4 / D-W2.3).
 *
 * Patrón espejo de RadiusAuthIngestScheduler.test.ts:
 *   S7.1 flag 'pppoe-auto-move' OFF (o AUSENTE) → el tick retorna sin trabajo (dark by default)
 *   S7.3 flag ON → procesa; vuelto a OFF → el tick siguiente ya no procesa (SIN restart)
 *   S7.2 intervalo inválido → default 2 min (parseIntervalMs, el boot NUNCA falla)
 *   reentrancy: tick anterior en vuelo → skip · lock cross-replica tomado → skip
 *   error del run → swallowed (el scheduler sigue vivo) · lock liberado tras cada run
 */
import { PppoeAutoMoveScheduler } from '@infrastructure/scheduling/PppoeAutoMoveScheduler';
import { AutoMovePppoe } from '@application/use-cases/AutoMovePppoe';
import { MovePppoeToNas } from '@application/use-cases/MovePppoeToNas';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
import { FindFreeIp } from '@application/use-cases/FindFreeIp';
import { parseIntervalMs } from '@infrastructure/parseIntervalMs';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { InMemoryPppoeNasMoveEventRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeNasMoveEventRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';

const FLAG_KEY = 'pppoe-auto-move';
const LOCK_KEY = 'pppoe-auto-move';

function makeHarness(flagEnabled?: boolean) {
  const pppoeRepo    = new InMemoryPppoeServiceRepository();
  const nasRepo      = new InMemoryNasRepository();
  const routerGw     = new InMemoryRouterGateway();
  const netRepo      = new InMemoryIpNetworkRepository();
  const moveEvents   = new InMemoryPppoeNasMoveEventRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway({ globalSessions: [] });

  const findFreeIp = new FindFreeIp(netRepo, nasRepo, routerGw, orchestrator);
  const legacyMove = new MovePppoeServiceToRouter(pppoeRepo, routerGw, nasRepo);
  const move = new MovePppoeToNas(
    pppoeRepo, nasRepo, orchestrator, findFreeIp, legacyMove, moveEvents,
    new InMemoryServiceCatalogRepository(), new InMemoryContractServiceEventRepository(), netRepo,
  );
  const autoMove = new AutoMovePppoe(orchestrator, nasRepo, pppoeRepo, netRepo, moveEvents, move);

  const flags = new InMemoryFeatureFlagRepository();
  if (flagEnabled !== undefined) flags.seed(FLAG_KEY, flagEnabled);
  const lock = new InMemoryDistributedLock();
  const scheduler = new PppoeAutoMoveScheduler(autoMove, { intervalMs: 1000, silent: true }, lock, flags);
  return { scheduler, autoMove, flags, lock };
}

describe('PppoeAutoMoveScheduler', () => {
  it('S7.1: flag OFF → el tick retorna sin trabajo (cero moves)', async () => {
    const { scheduler, autoMove } = makeHarness(false);
    const spy = jest.spyOn(autoMove, 'run');
    const summary = await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('S7.1: flag AUSENTE (sin seed en la tabla) → dark by default, tick no-op', async () => {
    const { scheduler, autoMove } = makeHarness(undefined);
    const spy = jest.spyOn(autoMove, 'run');
    const summary = await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('flag ON → el tick procesa y devuelve el resumen del run', async () => {
    const { scheduler } = makeHarness(true);
    const summary = await scheduler.runOnce();
    expect(summary.skipped).toBeUndefined();
    // D-W2.5 item 8: summary honesto — el shape pineado incluye los counters del endurecimiento
    // (breaker/cap/cooldown/re-verify/terminated/freshness/conflicto). Test actualizado del
    // contrato W2 original (8 campos).
    expect(summary.result).toEqual({
      sessions: 0, mismatches: 0, moved: 0, skippedPublic: 0,
      skippedUnknownNas: 0, failed: 0, throttled: 0, ignoredNoService: 0,
      aborted: false, deferred: 0, skippedCooldown: 0, alreadyConverged: 0,
      skippedTerminated: 0, skippedStale: 0, nasConflicts: 0,
    });
  });

  it('D-W2.5 (item 9): flags.get lanza → runOnce NO rechaza (catch propio del tick) y el tick siguiente corre', async () => {
    // Sin el catch propio, un throw ANTES del run (flags.get / tryAcquire) rechazaba runOnce()
    // y el `void this.runOnce()` del timer quedaba como unhandled rejection.
    const { scheduler, flags } = makeHarness(true);
    jest.spyOn(flags, 'get').mockRejectedValueOnce(new Error('flag db down'));

    await expect(scheduler.runOnce()).resolves.toMatchObject({
      error: expect.stringContaining('flag db down'),
    });

    const next = await scheduler.runOnce(); // inFlight liberado, el scheduler sigue vivo
    expect(next.result).toBeDefined();
  });

  it('S7.3: ON → procesa; vuelto a OFF → el tick siguiente NO procesa (sin restart, chequeo POR tick)', async () => {
    const { scheduler, autoMove, flags } = makeHarness(true);
    const spy = jest.spyOn(autoMove, 'run');

    const first = await scheduler.runOnce();
    expect(first.result).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);

    await flags.setEnabled(FLAG_KEY, false);
    const second = await scheduler.runOnce();
    expect(second.skipped).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1); // no volvió a correr
  });

  it('reentrancy: tick anterior en vuelo → skip', async () => {
    const { scheduler } = makeHarness(true);
    const [a, b] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    const skipped = [a, b].filter(r => r.skipped).length;
    expect(skipped).toBe(1);
  });

  it('lock tomado por otra réplica → skip', async () => {
    const { scheduler, lock, autoMove } = makeHarness(true);
    lock.forceAcquireFails = true;
    const spy = jest.spyOn(autoMove, 'run');
    const summary = await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('best-effort: error del run no tira el scheduler (loguea y continúa)', async () => {
    const { scheduler, autoMove } = makeHarness(true);
    jest.spyOn(autoMove, 'run').mockRejectedValueOnce(new Error('orchestrator caido'));
    const summary = await scheduler.runOnce();
    expect(summary.error).toContain('orchestrator caido');
    // El tick siguiente vuelve a correr (inFlight liberado).
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

describe('AUTO_MOVE_INTERVAL_MS — contrato del intervalo (S7.2)', () => {
  const OPTS = { default: 120_000, min: 15_000, max: 86_400_000 };

  it('valor inválido → default 2 min (el boot NUNCA falla: parseIntervalMs no lanza)', () => {
    expect(parseIntervalMs('garbage', OPTS)).toBe(120_000);
  });

  it('ausente → default 2 min', () => {
    expect(parseIntervalMs(undefined, OPTS)).toBe(120_000);
  });

  it('debajo del piso → clamp a 15s; encima del techo → clamp a 24h', () => {
    expect(parseIntervalMs('1000', OPTS)).toBe(15_000);
    expect(parseIntervalMs('999999999999', OPTS)).toBe(86_400_000);
  });
});
