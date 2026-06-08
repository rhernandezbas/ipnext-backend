import { describe, it, expect, jest } from '@jest/globals';
import { TaskAutocompleteScheduler } from '@infrastructure/scheduling/TaskAutocompleteScheduler';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';

const opts = { intervalMs: 1000, silent: true };

const MANUAL_FLAG = 'iclass-closure-reprocess';

function lockStub(acquired = true) {
  return { tryAcquire: async () => acquired, release: async () => {} } as never;
}
function reprocessStub(result: unknown) {
  return { execute: async () => result } as never;
}

/** Flags con la clave manual habilitada por defecto */
function flagsWithManual(enabled = true) {
  const f = new InMemoryFeatureFlagRepository();
  f.seed(MANUAL_FLAG, enabled);
  return f;
}

describe('TaskAutocompleteScheduler — cron paths (REQ-SCHED-1)', () => {
  it('skips when the flag is off (reprocess returns skipped)', async () => {
    const flags = new InMemoryFeatureFlagRepository(); // manual flag no existe → disabled
    const s = new TaskAutocompleteScheduler(
      reprocessStub({ skipped: true }),
      opts,
      lockStub(true),
      flags,
      reprocessStub({ skipped: false, processed: 0, candidates: 0, noTask: 0 }),
    );
    expect(await s.runOnce()).toMatchObject({ skipped: true });
  });

  it('skips when the lock is held by another instance', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    const s = new TaskAutocompleteScheduler(
      reprocessStub({ skipped: false, processed: 5 }),
      opts,
      lockStub(false),
      flags,
      reprocessStub({ skipped: false, processed: 0, candidates: 0, noTask: 0 }),
    );
    expect(await s.runOnce()).toMatchObject({ skipped: true });
  });

  it('runs the reprocess when the flag is on', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    const s = new TaskAutocompleteScheduler(
      reprocessStub({ skipped: false, processed: 2, candidates: 3, noTask: 0 }),
      opts,
      lockStub(true),
      flags,
      reprocessStub({ skipped: false, processed: 0, candidates: 0, noTask: 0 }),
    );
    expect(await s.runOnce()).toMatchObject({ processed: 2 });
  });
});

describe('TaskAutocompleteScheduler — triggerNow (REQ-TRIGGER-1)', () => {
  it('triggerNow queued: returns {queued:true} when flag ON and not in flight (REQ-TRIGGER-1)', async () => {
    const flags = flagsWithManual(true);
    const manualReprocess = reprocessStub({ skipped: false, processed: 1, candidates: 1, noTask: 0 });
    const s = new TaskAutocompleteScheduler(
      reprocessStub({ skipped: true }),
      opts,
      lockStub(true),
      flags,
      manualReprocess,
    );

    const result = await s.triggerNow();
    expect(result).toEqual({ queued: true });
  });

  it('triggerNow already-running: returns {queued:false, reason:"already-running"} when inFlight=true', async () => {
    const flags = flagsWithManual(true);
    const slowManual = { execute: () => new Promise<never>(() => { /* nunca resuelve */ }) } as never;
    const s = new TaskAutocompleteScheduler(
      reprocessStub({ skipped: true }),
      opts,
      lockStub(true),
      flags,
      slowManual,
    );

    // Lanzar primer triggerNow para poner inFlight=true
    void s.triggerNow();
    // Dar un tick para que runOnce ponga inFlight=true
    await new Promise(r => setImmediate(r));

    const result = await s.triggerNow();
    expect(result).toEqual({ queued: false, reason: 'already-running' });
  });

  it('triggerNow flag-disabled: returns {queued:false, reason:"flag-disabled"} when manual flag OFF', async () => {
    const flags = flagsWithManual(false); // flag apagado
    const s = new TaskAutocompleteScheduler(
      reprocessStub({ skipped: true }),
      opts,
      lockStub(true),
      flags,
      reprocessStub({ skipped: false, processed: 0, candidates: 0, noTask: 0 }),
    );

    const result = await s.triggerNow();
    expect(result).toEqual({ queued: false, reason: 'flag-disabled' });
  });

  it('triggerNow con cron flag OFF: sigue funcionando (bandera manual independiente)', async () => {
    // El cron tiene su propio reprocess (task-autocomplete), el manual usa iclass-closure-reprocess.
    // Solo el flag manual importa para triggerNow.
    const flags = flagsWithManual(true); // manual ON
    // cronReprocess retorna skipped=true (como si task-autocomplete estuviera OFF)
    const cronReprocess = reprocessStub({ skipped: true });
    const manualReprocess = reprocessStub({ skipped: false, processed: 1, candidates: 1, noTask: 0 });
    const s = new TaskAutocompleteScheduler(
      cronReprocess,
      opts,
      lockStub(true),
      flags,
      manualReprocess,
    );

    const result = await s.triggerNow();
    expect(result).toEqual({ queued: true });
  });
});
