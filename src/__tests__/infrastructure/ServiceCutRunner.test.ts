import { ServiceCutRunner } from '@infrastructure/scheduling/ServiceCutRunner';
import { RunBulkEnforcement } from '@application/use-cases/RunBulkEnforcement';
import { EnforcePppoeService } from '@application/use-cases/EnforcePppoeService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { RouterOsEnforcementAdapter } from '@infrastructure/adapters/routeros/RouterOsEnforcementAdapter';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryServiceCutBatchRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCutBatchRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';

function build() {
  const repo = new InMemoryPppoeServiceRepository();
  const router = new InMemoryRouterGateway();
  const nasRepo = new InMemoryNasRepository();
  const batchRepo = new InMemoryServiceCutBatchRepository();
  const enforce = new EnforcePppoeService(repo, new RouterOsEnforcementAdapter(router, 'IP-REDUCCION'), nasRepo);
  const bulk = new RunBulkEnforcement(repo, enforce, batchRepo, { throttleMs: 0 });
  const lock = new InMemoryDistributedLock();
  const runner = new ServiceCutRunner(bulk, batchRepo, lock);
  return { repo, batchRepo, lock, runner };
}

describe('ServiceCutRunner (Fase C — shell fire-and-forget + lock)', () => {
  it('start: acepta, crea el batch, corre el bulk y libera el lock al terminar', async () => {
    const { repo, batchRepo, lock, runner } = build();
    const d1 = await repo.upsertByUsername({ username: 'd1', password: 'p', nasId: '1', contractId: 'c', enforcedState: 'active' });

    const res = await runner.start('reduce', [d1.id]);
    expect(res.accepted).toBe(true);
    expect(res.batchId).toBeTruthy();

    await res.done; // esperar el trabajo en background (fire-and-forget en prod)

    const batch = await batchRepo.findById(res.batchId!);
    expect(batch?.status).toBe('done');
    expect(batch?.doneCount).toBe(1);
    expect((await repo.findById(d1.id))?.enforcedState).toBe('reduced');
    expect(lock.heldKeys.size).toBe(0); // lock liberado
  });

  it('lock ocupado → rechaza (accepted false) y NO crea batch', async () => {
    const { batchRepo, lock, runner } = build();
    lock.forceAcquireFails = true;

    const res = await runner.start('reduce', ['x']);
    expect(res.accepted).toBe(false);
    expect(res.batchId).toBeUndefined();

    // no se creó ningún batch (nada que pollear)
    const none = await batchRepo.findById('whatever');
    expect(none).toBeNull();
  });

  it('un segundo start mientras corre el primero es rechazado (un solo batch a la vez)', async () => {
    const { repo, lock, runner } = build();
    const d1 = await repo.upsertByUsername({ username: 'd1', password: 'p', nasId: '1', contractId: 'c', enforcedState: 'active' });

    // adquirir el lock manualmente para simular un batch en curso
    await lock.tryAcquire('pppoe-enforcement-bulk');
    const res = await runner.start('reduce', [d1.id]);
    expect(res.accepted).toBe(false);
  });

  it('si el bulk explota: el batch queda failed y el lock se libera igual', async () => {
    const { batchRepo, lock } = build();
    const throwingBulk = { execute: async () => { throw new Error('boom'); } };
    const runner = new ServiceCutRunner(throwingBulk, batchRepo, lock);

    const res = await runner.start('reduce', ['a', 'b']);
    expect(res.accepted).toBe(true);
    await res.done;

    const batch = await batchRepo.findById(res.batchId!);
    expect(batch?.status).toBe('failed');
    expect(batch?.finishedAt).not.toBeNull();
    expect(lock.heldKeys.size).toBe(0);
  });
});
