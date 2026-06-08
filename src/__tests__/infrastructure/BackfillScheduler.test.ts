import { describe, it, expect } from '@jest/globals';
import { BackfillScheduler } from '@infrastructure/scheduling/BackfillScheduler';
import type { BackfillClosedServiceOrders } from '@application/use-cases/BackfillClosedServiceOrders';
import type { DistributedLock } from '@domain/ports/DistributedLock';

/** Stub del use case BackfillClosedServiceOrders */
function backfillStub(
  result: { mirrored: number; transitioned: number; skippedNotClosed: number; skippedNotOurs: number; skippedUnchanged: number; failed: number } = {
    mirrored: 1, transitioned: 1, skippedNotClosed: 0, skippedNotOurs: 0, skippedUnchanged: 0, failed: 0,
  },
) {
  return { execute: async () => result } as unknown as BackfillClosedServiceOrders;
}

/** Lock stub configurable: acquired=true por defecto */
function lockStub(acquired = true): DistributedLock {
  return { tryAcquire: async () => acquired, release: async () => {} } as DistributedLock;
}

/** Lock que nunca devuelve (simula proceso largo) */
function slowLockStub(): DistributedLock {
  return {
    tryAcquire: async () => true,
    release: async () => {},
  } as DistributedLock;
}

/** BackfillStub que nunca resuelve (simula proceso largo en vuelo) */
function neverResolveBackfill(): BackfillClosedServiceOrders {
  return { execute: () => new Promise<never>(() => { /* nunca resuelve */ }) } as unknown as BackfillClosedServiceOrders;
}

describe('BackfillScheduler — triggerNow (REQ-BACKFILL-SCHEDULER-1)', () => {
  // A1.1: triggerNow returns {queued:true} when idle
  it('returns {queued:true} when idle (inFlight=false)', async () => {
    const scheduler = new BackfillScheduler(backfillStub(), lockStub(true), { silent: true });
    const result = await scheduler.triggerNow();
    expect(result).toEqual({ queued: true });
  });

  // Triangulación A1.1: triggerNow devuelve {queued:true} incluso cuando el work lleva tiempo
  it('returns {queued:true} synchronously before execute() completes', async () => {
    const scheduler = new BackfillScheduler(neverResolveBackfill(), slowLockStub(), { silent: true });
    // triggerNow debe retornar antes de que el work termine
    const result = await scheduler.triggerNow();
    expect(result).toEqual({ queued: true });
  });

  // A1.2: re-entrancy guard — returns {queued:false, reason:'already-running'} when inFlight=true
  it('returns {queued:false, reason:"already-running"} when inFlight=true', async () => {
    const scheduler = new BackfillScheduler(neverResolveBackfill(), slowLockStub(), { silent: true });

    // Primer disparo: pone inFlight=true internamente
    void scheduler.triggerNow();
    // Dar un tick para que runOnce ponga inFlight=true
    await new Promise(r => setImmediate(r));

    const result = await scheduler.triggerNow();
    expect(result).toEqual({ queued: false, reason: 'already-running' });
  });

  // Triangulación A1.2: segundo triggerNow no lanza execute() adicional
  it('does not start a second parallel run when already in flight', async () => {
    let executeCount = 0;
    const countingBackfill = {
      execute: () => {
        executeCount++;
        return new Promise<never>(() => { /* nunca resuelve */ });
      },
    } as unknown as BackfillClosedServiceOrders;

    const scheduler = new BackfillScheduler(countingBackfill, slowLockStub(), { silent: true });

    void scheduler.triggerNow(); // primer disparo
    await new Promise(r => setImmediate(r)); // inFlight=true

    await scheduler.triggerNow(); // segundo disparo — debe ser rechazado
    await new Promise(r => setImmediate(r));

    // execute() solo debe haberse llamado UNA vez
    expect(executeCount).toBe(1);
  });

  // A1.3: lock no adquirido → runOnce salta execute
  it('runOnce skips execute() when lock is not acquired', async () => {
    let executeCount = 0;
    const trackingBackfill = {
      execute: async () => {
        executeCount++;
        return { mirrored: 1, transitioned: 1, skippedNotClosed: 0, skippedNotOurs: 0, skippedUnchanged: 0 };
      },
    } as unknown as BackfillClosedServiceOrders;

    const scheduler = new BackfillScheduler(trackingBackfill, lockStub(false), { silent: true });
    const runResult = await scheduler.runOnce();

    expect(runResult).toMatchObject({ skipped: true });
    expect(executeCount).toBe(0);
  });

  // Triangulación A1.3: lock key es 'iclass-closure-backfill' y no colisiona con otros
  it('uses lock key "iclass-closure-backfill" (distinct from task-autocomplete and iclass-closed)', async () => {
    const acquiredKeys: string[] = [];
    const trackingLock: DistributedLock = {
      tryAcquire: async (key: string) => { acquiredKeys.push(key); return true; },
      release: async () => {},
    };

    const scheduler = new BackfillScheduler(backfillStub(), trackingLock, { silent: true });
    await scheduler.runOnce();

    expect(acquiredKeys).toContain('iclass-closure-backfill');
    expect(acquiredKeys).not.toContain('task-autocomplete');
    expect(acquiredKeys).not.toContain('iclass-closed');
  });

  // ── Task 4.1: done-log line includes failed= (REQ-STATUS-1 logging) ──────

  it('4.1: done-log line includes failed= field (REQ-STATUS-1)', async () => {
    const logLines: string[] = [];
    const captureLog = (msg: string) => logLines.push(msg);

    // Stub with failed=2 to confirm it appears in the log
    const stub = backfillStub({ mirrored: 3, transitioned: 2, skippedNotClosed: 0, skippedNotOurs: 1, skippedUnchanged: 0, failed: 2 });
    const scheduler = new BackfillScheduler(stub, lockStub(true), { silent: false });
    // Capture console.log
    const origLog = console.log;
    console.log = captureLog;
    try {
      await scheduler.runOnce();
    } finally {
      console.log = origLog;
    }

    const doneLine = logLines.find(l => l.includes('[backfill-scheduler] done'));
    expect(doneLine).toBeDefined();
    expect(doneLine).toContain('failed=2');
  });

  it('4.1 triangulation: failed=0 is also logged when no task failures', async () => {
    const logLines: string[] = [];
    const captureLog = (msg: string) => logLines.push(msg);

    const stub = backfillStub({ mirrored: 1, transitioned: 1, skippedNotClosed: 0, skippedNotOurs: 0, skippedUnchanged: 0, failed: 0 });
    const scheduler = new BackfillScheduler(stub, lockStub(true), { silent: false });
    const origLog = console.log;
    console.log = captureLog;
    try {
      await scheduler.runOnce();
    } finally {
      console.log = origLog;
    }

    const doneLine = logLines.find(l => l.includes('[backfill-scheduler] done'));
    expect(doneLine).toBeDefined();
    expect(doneLine).toContain('failed=0');
  });
});
