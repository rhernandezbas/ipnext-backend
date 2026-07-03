/**
 * pppoe-preprovision-autoinstall — barrido nasId-null (tasks 1.3, REQ-PRE-4).
 *
 * Un PENDIENTE de instalación (nasId null) NO es operable hasta la adopción — cada operación
 * que necesita NAS responde con el error tipado PPPOE_PENDING_INSTALL (409 en el wire), NUNCA
 * un crash ni un NasNotFound confuso. Excepciones deliberadas:
 *   - move manual = adopción (MovePppoeToNas.adoption.test.ts),
 *   - terminate = baja del RADIUS central (el pendiente VIVE en el RADIUS, no necesita NAS).
 * El enforcement masivo lo EXCLUYE (limitación documentada en el proposal: no aplica hasta
 * la adopción): preview no lo cuenta y el bulk lo reporta failed tipado.
 */
import { EnforcePppoeService } from '@application/use-cases/EnforcePppoeService';
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { DeactivatePppoeService } from '@application/use-cases/DeactivatePppoeService';
import { TerminatePppoeService } from '@application/use-cases/TerminatePppoeService';
import { RenamePppoeUsername } from '@application/use-cases/RenamePppoeUsername';
import { PreviewEnforcement } from '@application/use-cases/PreviewEnforcement';
import { RunBulkEnforcement } from '@application/use-cases/RunBulkEnforcement';
import { BulkChangePppoePlan } from '@application/use-cases/BulkChangePppoePlan';
import { ChangePppoePlanService } from '@application/services/ChangePppoePlanService';
import { ListPppoeAssignments } from '@application/use-cases/ListPppoeAssignments';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryServiceCutBatchRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCutBatchRepository';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';
import { PppoePendingInstallError } from '@domain/errors/pppoe';
import type { EnforcementGateway } from '@domain/ports/EnforcementGateway';

/** Gateway de enforcement espía: registra si la red fue tocada. */
class SpyEnforcementGateway implements EnforcementGateway {
  public applied = 0;
  async apply(): Promise<void> {
    this.applied++;
  }
}

function makeBase() {
  const repo = new InMemoryPppoeServiceRepository();
  const router = new InMemoryRouterGateway();
  const nasRepo = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();
  const ensure = new EnsureInternetContractService(
    new InMemoryContractServiceRepository(),
    new InMemoryServiceCatalogRepository(),
  );
  return { repo, router, nasRepo, orchestrator, ensure };
}

async function seedPending(repo: InMemoryPppoeServiceRepository, username = 'pendiente') {
  return repo.upsertByUsername({
    username,
    password: 'secret',
    profile: 'IP-Air-10M',
    remoteAddress: null,
    status: 'enabled',
    nasId: null,
    contractId: null,
    ipMode: 'fixed',
    ipTypePreference: 'cgnat',
  });
}

describe('Barrido nasId-null — pendiente NO operable (REQ-PRE-4)', () => {
  it('S4.2: enforce de un pendiente → PppoePendingInstallError, la red NO se toca', async () => {
    const { repo, nasRepo } = makeBase();
    const gw = new SpyEnforcementGateway();
    const uc = new EnforcePppoeService(repo, gw, nasRepo);
    const s = await seedPending(repo);

    await expect(uc.execute({ id: s.id, action: 'reduce' }))
      .rejects.toBeInstanceOf(PppoePendingInstallError);
    expect(gw.applied).toBe(0);

    const row = await repo.findById(s.id);
    expect(row!.enforcedState).toBe('active');
  });

  it('update (PATCH) de un pendiente → PppoePendingInstallError, plano de control intacto', async () => {
    const { repo, router, nasRepo, orchestrator } = makeBase();
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator);
    const s = await seedPending(repo);

    await expect(uc.execute({ id: s.id, password: 'nueva' }))
      .rejects.toBeInstanceOf(PppoePendingInstallError);
    expect(orchestrator.calls).toHaveLength(0);
  });

  it('baja SOFT (deactivate) de un pendiente → PppoePendingInstallError', async () => {
    const { repo, router, nasRepo, orchestrator, ensure } = makeBase();
    const uc = new DeactivatePppoeService(repo, router, nasRepo, orchestrator, ensure);
    const s = await seedPending(repo);

    await expect(uc.execute(s.id)).rejects.toBeInstanceOf(PppoePendingInstallError);
    const row = await repo.findById(s.id);
    expect(row!.status).toBe('enabled');
  });

  it('rename de un pendiente → PppoePendingInstallError, RADIUS intacto', async () => {
    const { repo, nasRepo, orchestrator } = makeBase();
    const uc = new RenamePppoeUsername(repo, orchestrator, nasRepo);
    const s = await seedPending(repo);

    await expect(uc.execute({ id: s.id, newUsername: 'otro' }))
      .rejects.toBeInstanceOf(PppoePendingInstallError);
    expect(orchestrator.calls).toHaveLength(0);
  });

  it('TERMINATE de un pendiente SÍ funciona: baja del RADIUS central + fila borrada (escape de limpieza)', async () => {
    const { repo, router, nasRepo, orchestrator, ensure } = makeBase();
    const uc = new TerminatePppoeService(repo, orchestrator, router, nasRepo, ensure);
    const s = await seedPending(repo);
    // El pendiente existe en el RADIUS (lo creó la pre-provisión).
    await orchestrator.createUser({ username: 'pendiente', password: 'secret', plan: 'IP-Air-10M' });
    orchestrator.calls.length = 0;

    await uc.execute(s.id);

    expect(orchestrator.calls.some(c => c.op === 'deleteUser' && c.username === 'pendiente')).toBe(true);
    expect(await repo.findById(s.id)).toBeNull();
  });
});

describe('Barrido nasId-null — enforcement masivo EXCLUYE pendientes (limitación documentada)', () => {
  it('preview: el pendiente NO cuenta (total 0, byRouter vacío)', async () => {
    const { repo } = makeBase();
    const s = await seedPending(repo);
    const uc = new PreviewEnforcement(repo);

    const preview = await uc.execute({ action: 'reduce', target: { pppoeIds: [s.id] } });

    expect(preview.total).toBe(0);
    expect(preview.byRouter).toEqual({});
    expect(preview.pppoeIds).toEqual([]);
  });

  it('bulk enforcement con id pendiente → item failed PPPOE_PENDING_INSTALL (sin tocar la red)', async () => {
    const { repo, nasRepo } = makeBase();
    const gw = new SpyEnforcementGateway();
    const enforce = new EnforcePppoeService(repo, gw, nasRepo);
    const batchRepo = new InMemoryServiceCutBatchRepository();
    const batch = await batchRepo.create({ action: 'reduce', total: 1 });
    const uc = new RunBulkEnforcement(repo, enforce, batchRepo, { throttleMs: 0 });
    const s = await seedPending(repo);

    const result = await uc.execute({ batchId: batch.id, action: 'reduce', pppoeIds: [s.id] });

    expect(result.failedCount).toBe(1);
    expect(result.result).toEqual([{ pppoeId: s.id, ok: false, error: 'PPPOE_PENDING_INSTALL' }]);
    expect(gw.applied).toBe(0);
  });

  it('bulk change-plan con id pendiente → failed PPPOE_PENDING_INSTALL, el resto del lote sigue', async () => {
    const { repo, router, nasRepo, orchestrator } = makeBase();
    const planRepo = new InMemoryPlanRepository();
    await planRepo.upsertByCode({ code: 'IP-50M', name: 'IP 50M', category: 'internet', downloadKbps: 50_000, uploadKbps: 25_000 });
    const changeSvc = new ChangePppoePlanService(
      repo, router, nasRepo, orchestrator,
      new InMemoryServiceCatalogRepository(), new InMemoryContractServiceEventRepository(),
    );
    const uc = new BulkChangePppoePlan(repo, planRepo, nasRepo, changeSvc, { throttleMs: 0 });

    const pending = await seedPending(repo);
    const normal = await repo.upsertByUsername({
      username: 'normal', password: 'p', profile: 'P1', remoteAddress: null,
      status: 'enabled', nasId: '3', contractId: null, ipMode: 'fixed',
      ipTypePreference: 'cgnat', // pppoe-preprovision: explícito (default de las filas legacy)
    });

    const result = await uc.execute({ ids: [pending.id, normal.id], profile: 'IP-50M' });

    expect(result.ok).toEqual([normal.id]);
    expect(result.failed).toEqual([
      { id: pending.id, username: 'pendiente', error: 'PPPOE_PENDING_INSTALL' },
    ]);
  });
});

describe('Barrido nasId-null — listados tolerantes', () => {
  it('asignaciones (tab Asignaciones): un pendiente JAMÁS aparece (sin IP ni NAS)', async () => {
    const { repo } = makeBase();
    await seedPending(repo);
    await repo.upsertByUsername({
      username: 'asignado', password: 'p', profile: 'P1', remoteAddress: '100.64.43.10',
      status: 'enabled', nasId: '3', contractId: 'ct-1', ipMode: 'fixed',
      ipTypePreference: 'cgnat', // pppoe-preprovision: explícito (default de las filas legacy)
    });
    const uc = new ListPppoeAssignments(repo);

    const page = await uc.execute({ page: 1, pageSize: 20 });

    expect(page.total).toBe(1);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]!.username).toBe('asignado');
    expect(page.data[0]!.nasId).toBe('3');
  });
});
