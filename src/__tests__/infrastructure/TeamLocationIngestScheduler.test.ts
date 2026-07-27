import { TeamLocationIngestScheduler } from '@infrastructure/scheduling/TeamLocationIngestScheduler';
import type { FeatureFlag, FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import type { IngestRunSummary } from '@domain/ports/TeamLocationRepository';

const SUMMARY: IngestRunSummary = {
  teamsProcessed: 6,
  pointsNew: 120,
  pointsDuplicate: 40,
  pointsPurged: 0,
  pagesRead: 14,
  pointsDropped: 0,
  incompleteTeams: [],
};

function flags(enabled: boolean | null): FeatureFlagRepository {
  return {
    async list() {
      return [];
    },
    async get(key: string): Promise<FeatureFlag | null> {
      if (enabled === null) return null;
      return { key, enabled, updatedAt: '2026-07-26T12:00:00.000Z' };
    },
    async setEnabled(key: string, value: boolean) {
      return { key, enabled: value, updatedAt: '2026-07-26T12:00:00.000Z' };
    },
  };
}

function lock(acquirable = true): DistributedLock & { released: number } {
  const state = {
    released: 0,
    async tryAcquire() {
      return acquirable;
    },
    async release() {
      state.released++;
    },
  };
  return state;
}

function ingest(impl?: () => Promise<IngestRunSummary>) {
  const execute = jest.fn(impl ?? (async () => SUMMARY));
  return { execute } as unknown as { execute: jest.Mock };
}

describe('TeamLocationIngestScheduler', () => {
  it('does NOT run when the feature flag is off', async () => {
    const use = ingest();
    const res = await new TeamLocationIngestScheduler(
      use as never,
      flags(false),
      { intervalMs: 1000, silent: true },
      lock(),
    ).runOnce();

    expect(use.execute).not.toHaveBeenCalled();
    expect(res.skipped).toBe(true);
  });

  it('does NOT run when the flag does not exist yet (default OFF)', async () => {
    const use = ingest();
    const res = await new TeamLocationIngestScheduler(
      use as never,
      flags(null),
      { intervalMs: 1000, silent: true },
      lock(),
    ).runOnce();

    expect(use.execute).not.toHaveBeenCalled();
    expect(res.skipped).toBe(true);
  });

  it('runs the ingest when the flag is on', async () => {
    const use = ingest();
    const res = await new TeamLocationIngestScheduler(
      use as never,
      flags(true),
      { intervalMs: 1000, silent: true },
      lock(),
    ).runOnce();

    expect(use.execute).toHaveBeenCalledTimes(1);
    expect(res.summary).toEqual(SUMMARY);
  });

  it('skips when the distributed lock is held by another instance', async () => {
    const use = ingest();
    const res = await new TeamLocationIngestScheduler(
      use as never,
      flags(true),
      { intervalMs: 1000, silent: true },
      lock(false),
    ).runOnce();

    expect(use.execute).not.toHaveBeenCalled();
    expect(res.skipped).toBe(true);
  });

  it('always releases the lock, even when the ingest throws', async () => {
    const l = lock(true);
    const use = ingest(async () => {
      throw new Error('boom');
    });

    const res = await new TeamLocationIngestScheduler(
      use as never,
      flags(true),
      { intervalMs: 1000, silent: true },
      l,
    ).runOnce();

    expect(res.error).toBe('boom');
    expect(l.released).toBe(1);
  });

  it('does not start a second run while one is already in flight', async () => {
    // OJO con lo que este test SÍ y NO garantiza: `inFlight` se setea DESPUÉS de
    // resolver el flag y el lock, así que dos llamadas realmente simultáneas pueden
    // pasar ambas el chequeo. Es el mismo comportamiento que IClassClosureScheduler.
    // La exclusión REAL entre instancias la da el DistributedLock, no este flag
    // in-process (que sólo evita el solapamiento del propio intervalo).
    // Por eso el test deja avanzar la primera corrida antes de disparar la segunda.
    let resolve!: (v: IngestRunSummary) => void;
    const use = ingest(() => new Promise<IngestRunSummary>((r) => (resolve = r)));
    const scheduler = new TeamLocationIngestScheduler(
      use as never,
      flags(true),
      { intervalMs: 1000, silent: true },
      lock(),
    );

    const first = scheduler.runOnce();
    await new Promise((r) => setTimeout(r, 10)); // la 1ra llega a inFlight = true

    const second = await scheduler.runOnce();
    expect(second.skipped).toBe(true);

    resolve(SUMMARY);
    await first;
    expect(use.execute).toHaveBeenCalledTimes(1);
  });

  it('relies on the distributed lock for cross-instance exclusion', async () => {
    // Dos réplicas del backend corriendo el mismo tick: la que no obtiene el lock
    // NO ingesta. Esto es lo que de verdad evita el trabajo duplicado.
    const use = ingest();
    const res = await new TeamLocationIngestScheduler(
      use as never,
      flags(true),
      { intervalMs: 1000, silent: true },
      lock(false),
    ).runOnce();

    expect(res.skipped).toBe(true);
    expect(use.execute).not.toHaveBeenCalled();
  });

  it('surfaces incomplete teams in the run result instead of hiding them', async () => {
    const use = ingest(async () => ({ ...SUMMARY, incompleteTeams: ['IPNXEMAV'] }));
    const res = await new TeamLocationIngestScheduler(
      use as never,
      flags(true),
      { intervalMs: 1000, silent: true },
      lock(),
    ).runOnce();

    expect(res.summary?.incompleteTeams).toEqual(['IPNXEMAV']);
  });

  describe('R8 — rechazos de flag/lock no pueden matar el proceso', () => {
    it('does not reject when flags.get() rejects', async () => {
      // Los callers usan `void runOnce()`: un rechazo acá era unhandled rejection, y en
      // Node >= 15 eso mata el proceso. Ninguno de los tests anteriores lo cubría.
      const brokenFlags: FeatureFlagRepository = {
        async list() { return []; },
        async get() { throw new Error('pool timeout'); },
        async setEnabled(key: string, value: boolean) {
          return { key, enabled: value, updatedAt: '2026-07-26T12:00:00.000Z' };
        },
      };
      const res = await new TeamLocationIngestScheduler(
        ingest() as never, brokenFlags, { intervalMs: 1000, silent: true }, lock(),
      ).runOnce();
      expect(res.error).toBe('pool timeout');
    });

    it('does not reject when tryAcquire() rejects', async () => {
      const brokenLock: DistributedLock = {
        async tryAcquire() { throw new Error('conexión rota'); },
        async release() { /* no-op */ },
      };
      const res = await new TeamLocationIngestScheduler(
        ingest() as never, flags(true), { intervalMs: 1000, silent: true }, brokenLock,
      ).runOnce();
      expect(res.error).toBe('conexión rota');
    });

    it('does not let a rejecting release() clobber a SUCCESSFUL run', async () => {
      const brokenRelease: DistributedLock = {
        async tryAcquire() { return true; },
        async release() { throw new Error('release falló'); },
      };
      const res = await new TeamLocationIngestScheduler(
        ingest() as never, flags(true), { intervalMs: 1000, silent: true }, brokenRelease,
      ).runOnce();
      expect(res.summary).toEqual(SUMMARY);
      expect(res.error).toBeUndefined();
    });
  });

  it('unrefs its timer so it never keeps the process alive', () => {
    const scheduler = new TeamLocationIngestScheduler(
      ingest() as never,
      flags(false),
      { intervalMs: 60_000, silent: true },
      lock(),
    );
    scheduler.start();
    scheduler.stop();
    // Si el timer quedara referenciado, Jest avisaría "worker failed to exit gracefully".
    expect(true).toBe(true);
  });
});
