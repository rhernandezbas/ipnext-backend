import { RunBulkEnforcement } from '@application/use-cases/RunBulkEnforcement';
import { EnforcePppoeService } from '@application/use-cases/EnforcePppoeService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryServiceCutBatchRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCutBatchRepository';

const NAS_A = '1';          // 192.168.1.1
const NAS_B = '2';          // 192.168.2.1
const NAS_B_IP = '192.168.2.1';
const REDUCED = 'IP-REDUCCION';

async function setup(opts?: { unreachable?: string[]; sleep?: (ms: number) => Promise<void>; throttleMs?: number }) {
  const repo = new InMemoryPppoeServiceRepository();
  const router = new InMemoryRouterGateway({ unreachable: opts?.unreachable ?? [] });
  const nasRepo = new InMemoryNasRepository();
  const batchRepo = new InMemoryServiceCutBatchRepository();
  const enforce = new EnforcePppoeService(repo, router, nasRepo, REDUCED);
  const bulk = new RunBulkEnforcement(repo, enforce, batchRepo, {
    sleep: opts?.sleep ?? (async () => {}),
    throttleMs: opts?.throttleMs ?? 0,
    routerConcurrency: 8,
  });
  return { repo, router, nasRepo, batchRepo, enforce, bulk };
}

async function seedPppoe(repo: InMemoryPppoeServiceRepository, username: string, nasId: string, enforcedState: 'active' | 'reduced' | 'blocked' = 'active') {
  return repo.upsertByUsername({ username, password: 'p', profile: 'IP-Air', nasId, contractId: `c-${username}`, enforcedState });
}

describe('RunBulkEnforcement (Fase C — corte masivo por batch)', () => {
  it('agrupa por router y reduce todos los items; batch queda done con doneCount correcto', async () => {
    const { repo, batchRepo, bulk } = await setup();
    const d1 = await seedPppoe(repo, 'd1', NAS_A);
    const d2 = await seedPppoe(repo, 'd2', NAS_A);
    const d3 = await seedPppoe(repo, 'd3', NAS_B);
    const batch = await batchRepo.create({ action: 'reduce', total: 3 });

    const out = await bulk.execute({ batchId: batch.id, action: 'reduce', pppoeIds: [d1.id, d2.id, d3.id] });

    expect(out.status).toBe('done');
    expect(out.doneCount).toBe(3);
    expect(out.failedCount).toBe(0);
    expect(out.finishedAt).not.toBeNull();
    expect(out.result.filter(r => r.ok)).toHaveLength(3);
    // efecto real en la DB
    for (const id of [d1.id, d2.id, d3.id]) {
      expect((await repo.findById(id))?.enforcedState).toBe('reduced');
    }
  });

  it('best-effort: un router caído → ese item failed, el resto del lote continúa', async () => {
    const { repo, batchRepo, bulk } = await setup({ unreachable: [NAS_B_IP] });
    const d1 = await seedPppoe(repo, 'd1', NAS_A);
    const d2 = await seedPppoe(repo, 'd2', NAS_A);
    const d3 = await seedPppoe(repo, 'd3', NAS_B); // router caído
    const batch = await batchRepo.create({ action: 'reduce', total: 3 });

    const out = await bulk.execute({ batchId: batch.id, action: 'reduce', pppoeIds: [d1.id, d2.id, d3.id] });

    expect(out.status).toBe('done');             // el lote termina igual
    expect(out.doneCount).toBe(2);
    expect(out.failedCount).toBe(1);
    const failed = out.result.find(r => !r.ok);
    expect(failed?.pppoeId).toBe(d3.id);
    expect(failed?.error).toBeTruthy();
    // los de A sí se redujeron; el de B quedó intacto (no miente)
    expect((await repo.findById(d1.id))?.enforcedState).toBe('reduced');
    expect((await repo.findById(d3.id))?.enforcedState).toBe('active');
  });

  it('idempotente/resumible: items ya en el estado destino no se reprocesan (ok, sin doble efecto)', async () => {
    const { repo, batchRepo, bulk } = await setup();
    const d1 = await seedPppoe(repo, 'd1', NAS_A, 'reduced'); // ya hecho (resume)
    const d2 = await seedPppoe(repo, 'd2', NAS_A, 'active');
    const batch = await batchRepo.create({ action: 'reduce', total: 2 });

    const out = await bulk.execute({ batchId: batch.id, action: 'reduce', pppoeIds: [d1.id, d2.id] });

    expect(out.doneCount).toBe(2);  // d1 no-op (ok), d2 reducido
    expect(out.failedCount).toBe(0);
    expect((await repo.findById(d2.id))?.enforcedState).toBe('reduced');
  });

  it('pppoe inexistente → item failed, no aborta', async () => {
    const { repo, batchRepo, bulk } = await setup();
    const d1 = await seedPppoe(repo, 'd1', NAS_A);
    const batch = await batchRepo.create({ action: 'reduce', total: 2 });

    const out = await bulk.execute({ batchId: batch.id, action: 'reduce', pppoeIds: [d1.id, 'no-existe'] });

    expect(out.doneCount).toBe(1);
    expect(out.failedCount).toBe(1);
    expect(out.result.find(r => r.pppoeId === 'no-existe')?.ok).toBe(false);
  });

  it('throttle inyectable: aplica el sleep entre operaciones del mismo router', async () => {
    const sleep = jest.fn(async () => {});
    const { repo, batchRepo, bulk } = await setup({ sleep, throttleMs: 300 });
    const d1 = await seedPppoe(repo, 'd1', NAS_A);
    const d2 = await seedPppoe(repo, 'd2', NAS_A);
    const batch = await batchRepo.create({ action: 'reduce', total: 2 });

    await bulk.execute({ batchId: batch.id, action: 'reduce', pppoeIds: [d1.id, d2.id] });

    expect(sleep).toHaveBeenCalledWith(300);
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('best-effort de progreso: si los writes de progreso fallan, el corte igual completa todos los items', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const router = new InMemoryRouterGateway();
    const nasRepo = new InMemoryNasRepository();
    const inner = new InMemoryServiceCutBatchRepository();
    // Repo flaky: TIRA en los writes de progreso (status no-'done'), deja pasar el terminal.
    const flaky: typeof inner = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
      update: async (id: string, patch: any) => {
        if (patch.status !== 'done') throw new Error('db hiccup');
        return inner.update(id, patch);
      },
    });
    const enforce = new EnforcePppoeService(repo, router, nasRepo, REDUCED);
    const bulk = new RunBulkEnforcement(repo, enforce, flaky as any, { throttleMs: 0 });
    const d1 = await seedPppoe(repo, 'd1', NAS_A);
    const d2 = await seedPppoe(repo, 'd2', NAS_A);
    const batch = await inner.create({ action: 'reduce', total: 2 });

    // No debe tirar pese a que CADA write de progreso falla.
    const out = await bulk.execute({ batchId: batch.id, action: 'reduce', pppoeIds: [d1.id, d2.id] });

    expect(out.status).toBe('done');
    expect(out.doneCount).toBe(2);
    // los cortes SÍ se aplicaron en la DB real (el fallo era solo del tracking de progreso)
    expect((await repo.findById(d1.id))?.enforcedState).toBe('reduced');
    expect((await repo.findById(d2.id))?.enforcedState).toBe('reduced');
  });

  it('persiste progreso en el batch (poleable): doneCount/result se actualizan durante la corrida', async () => {
    const { repo, batchRepo, bulk } = await setup();
    const d1 = await seedPppoe(repo, 'd1', NAS_A);
    const batch = await batchRepo.create({ action: 'reduce', total: 1 });

    await bulk.execute({ batchId: batch.id, action: 'reduce', pppoeIds: [d1.id] });

    const persisted = await batchRepo.findById(batch.id);
    expect(persisted?.status).toBe('done');
    expect(persisted?.doneCount).toBe(1);
    expect(persisted?.result).toHaveLength(1);
  });
});
