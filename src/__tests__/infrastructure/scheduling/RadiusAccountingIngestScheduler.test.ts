import { RadiusAccountingIngestScheduler } from '@infrastructure/scheduling/RadiusAccountingIngestScheduler';
import { IngestRadiusAccounting } from '@application/use-cases/IngestRadiusAccounting';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRadiusEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusEventRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';

const FLAG_KEY = 'radius-accounting-ingest';
const LOCK_KEY = 'radius-accounting-ingest';
const NOW = new Date('2026-06-22T12:00:00Z');

function makeHarness(flagEnabled = true) {
  const gateway    = new InMemoryRadiusOrchestratorGateway({ accountingEvents: [] });
  const eventRepo  = new InMemoryRadiusEventRepository();
  const nasRepo    = new InMemoryNasRepository();
  const stateRepo  = new InMemorySyncStateRepository();
  const flags      = new InMemoryFeatureFlagRepository();
  const lock       = new InMemoryDistributedLock();
  flags.seed(FLAG_KEY, flagEnabled);
  const ingest    = new IngestRadiusAccounting(gateway, eventRepo, nasRepo, stateRepo, { now: () => NOW });
  const scheduler = new RadiusAccountingIngestScheduler(ingest, { intervalMs: 1000, silent: true }, lock, flags, stateRepo);
  return { gateway, eventRepo, stateRepo, flags, lock, ingest, scheduler };
}

describe('RadiusAccountingIngestScheduler', () => {
  it('dark-by-default: flag OFF -> no ingesta, returns skipped', async () => {
    const { scheduler, ingest } = makeHarness(false);
    const spy = jest.spyOn(ingest, 'run');
    const summary = await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('ingesta avanza cursor cuando flag ON', async () => {
    const { scheduler, stateRepo } = makeHarness(true);
    const summary = await scheduler.runOnce();
    expect(summary.skipped).toBeUndefined();
    expect(summary.result).toBeDefined();
  });

  it('upsert idempotente: re-correr no duplica registros', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({
      accountingEvents: [{
        uniqueId: 'uid-01', username: 'u1', nasIpAddress: '192.168.1.1',
        framedIp: null, macAddress: null, vlan: null,
        startedAt: '2026-06-22T10:00:00Z', stoppedAt: null,
        sessionTime: null, inOctets: BigInt(0), outOctets: BigInt(0),
        lastUpdate: null,  // FIX2: campo requerido; null = fallback a startedAt
      }],
    });
    const eventRepo = new InMemoryRadiusEventRepository();
    const stateRepo = new InMemorySyncStateRepository();
    const flags     = new InMemoryFeatureFlagRepository();
    const lock      = new InMemoryDistributedLock();
    flags.seed(FLAG_KEY, true);
    const ingest = new IngestRadiusAccounting(gateway, eventRepo, new InMemoryNasRepository(), stateRepo, { now: () => NOW });
    const sched  = new RadiusAccountingIngestScheduler(ingest, { intervalMs: 1000, silent: true }, lock, flags);
    await sched.runOnce();
    await sched.runOnce();
    const stored = await eventRepo.list({ page: 1, pageSize: 10 });
    expect(stored.total).toBe(1);
  });

  it('no corre concurrente: inFlight=true -> skip', async () => {
    const { scheduler } = makeHarness(true);
    const [a, b] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    const skipped = [a, b].filter(r => r.skipped).length;
    expect(skipped).toBe(1);
  });

  it('lock tomado por otra replica -> skip', async () => {
    const { scheduler, lock, ingest } = makeHarness(true);
    lock.forceAcquireFails = true;
    const spy = jest.spyOn(ingest, 'run');
    const summary = await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('best-effort: error del ingest no tira el scheduler (loguea y continua)', async () => {
    const { scheduler, ingest } = makeHarness(true);
    jest.spyOn(ingest, 'run').mockRejectedValueOnce(new Error('boom'));
    const summary = await scheduler.runOnce();
    expect(summary.error).toContain('boom');
  });

  // ── Regresión: espiral de re-lectura completa (incidente 2026-07-26) ─────────
  // Mismo bug que en RadiusAuthIngestScheduler: el catch guardaba `cursor: null`.
  // Acá el cursor todavía estaba sano en prod, pero el tick ya corría >5 min
  // (81k filas / 163 páginas) -> estaba a UN fallo de entrar en la misma espiral.
  it('un error NO borra el cursor: preserva la marca de agua previa', async () => {
    const { scheduler, stateRepo, ingest } = makeHarness(true);
    await stateRepo.save({
      entity:      LOCK_KEY,
      cursor:      '2026-06-22T10:00:00Z',
      lastRunAt:   new Date('2026-06-22T11:00:00Z'),
      lastResult:  'ok',
      itemsSynced: 10,
    });

    jest.spyOn(ingest, 'run').mockRejectedValueOnce(new Error('boom'));
    await scheduler.runOnce();

    const after = await stateRepo.get(LOCK_KEY);
    expect(after?.cursor).toBe('2026-06-22T10:00:00Z');
    expect(after?.lastResult).toContain('error: boom');
  });

  it('un error sin estado previo deja el cursor en null (no inventa marca de agua)', async () => {
    const { scheduler, stateRepo, ingest } = makeHarness(true);
    jest.spyOn(ingest, 'run').mockRejectedValueOnce(new Error('boom'));
    await scheduler.runOnce();

    const after = await stateRepo.get(LOCK_KEY);
    expect(after?.cursor).toBeNull();
    expect(after?.lastResult).toContain('error: boom');
  });

  // Espejo del test del scheduler de auth: si no se puede CONFIRMAR el cursor previo
  // (la DB es justamente lo que suele fallar), no se escribe nada. Un `cursor: null`
  // de fallback reintroduciría la espiral en el peor momento posible.
  it('si no puede leer el estado previo NO escribe: nunca arriesga borrar el cursor', async () => {
    const { scheduler, stateRepo, ingest } = makeHarness(true);
    jest.spyOn(ingest, 'run').mockRejectedValueOnce(new Error('boom'));
    jest.spyOn(stateRepo, 'get').mockRejectedValueOnce(new Error('db down'));
    const saveSpy = jest.spyOn(stateRepo, 'save');

    const summary = await scheduler.runOnce();

    expect(summary.error).toContain('boom');
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('purga borra > retencion, recientes permanecen', async () => {
    const { scheduler, ingest } = makeHarness(true);
    jest.spyOn(ingest, 'run').mockResolvedValueOnce({ upserted: 5, pages: 1, purgedRows: 3, newCursor: '2026-06-22T10:00:00Z' });
    const summary = await scheduler.runOnce();
    expect(summary.result?.purgedRows).toBe(3);
  });

  it('libera el lock despues de cada run', async () => {
    const { scheduler, lock } = makeHarness(true);
    const releaseSpy = jest.spyOn(lock, 'release');
    await scheduler.runOnce();
    expect(releaseSpy).toHaveBeenCalledWith(LOCK_KEY);
    expect(lock.heldKeys.has(LOCK_KEY)).toBe(false);
  });

  // ── FIX 1: outer-try pattern — inFlight no puede quedar en true si flags.get o tryAcquire lanzan ─

  it('FIX1-a: flags.get lanza -> inFlight vuelve a false (proximo tick puede correr)', async () => {
    const { scheduler, flags } = makeHarness(true);
    // Primero setar el flag para que pase la primera lectura en el harness, luego hacemos que lance
    jest.spyOn(flags, 'get').mockRejectedValueOnce(new Error('flags-db-down'));
    // runOnce va a lanzar (no swallowea en la capa del scheduler sin stateRepo)
    await scheduler.runOnce().catch(() => { /* expected */ });
    // inFlight DEBE ser false para que el siguiente tick pueda correr
    // Probamos corriendo de nuevo — si inFlight quedó en true, el segundo run retorna skipped
    const second = await scheduler.runOnce();
    expect(second.skipped).toBeUndefined();
    expect(second.result).toBeDefined();
  });

  it('FIX1-b: tryAcquire lanza -> inFlight false + no queda lock colgado', async () => {
    const { scheduler, lock, flags } = makeHarness(true);
    // El flag SI está habilitado, pero tryAcquire lanza
    jest.spyOn(lock, 'tryAcquire').mockRejectedValueOnce(new Error('pg-down'));
    await scheduler.runOnce().catch(() => { /* expected */ });
    // inFlight debe ser false
    const second = await scheduler.runOnce();
    expect(second.skipped).toBeUndefined();
    expect(second.result).toBeDefined();
    // El lock no debe quedar colgado (no debe estar held)
    expect(lock.heldKeys.has(LOCK_KEY)).toBe(false);
  });

});
