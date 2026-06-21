/**
 * TerminatePppoeService.test.ts — TDD (red → green → refactor)
 *
 * Cubre:
 *   - mikrotik_radius: llama orchestrator.deleteUser + sets status='terminated' + remoteAddress=null
 *   - mikrotik_radius: registra evento con reason via ensureInternet
 *   - mikrotik_radius: deleteUser lanza 502 → DB NO se modifica (atomicidad)
 *   - mikrotik_radius: kickea sesión live best-effort (disconnectSessions)
 *   - non-radius: llama router.removeSecret (en lugar de deleteUser)
 *   - PPPoE no encontrado → 404
 */
import { TerminatePppoeService } from '@application/use-cases/TerminatePppoeService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { PppoeServiceNotFoundError, OrchestratorRejectedError } from '@domain/errors/pppoe';

const NAS_RADIUS_ID = '3';   // type='mikrotik_radius' (seeded en InMemoryNasRepository)
const NAS_API_ID    = '1';   // type='mikrotik_api'
const CONTRACT_ID   = 'contract-abc';

function buildDeps(opts?: { orchestratorUnreachable?: string[] }) {
  const pppoeRepo   = new InMemoryPppoeServiceRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway({
    unreachable: opts?.orchestratorUnreachable,
  });
  const router      = new InMemoryRouterGateway();
  const nasRepo     = new InMemoryNasRepository();
  const csRepo      = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const eventRepo   = new InMemoryContractServiceEventRepository();
  const ensure      = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);

  const svc = new TerminatePppoeService(pppoeRepo, orchestrator, router, nasRepo, ensure);

  return { pppoeRepo, orchestrator, router, nasRepo, csRepo, catalogRepo, eventRepo, ensure, svc };
}

async function seedInternetLine(
  csRepo: InMemoryContractServiceRepository,
  catalogRepo: InMemoryServiceCatalogRepository,
  contractId: string,
) {
  const catalog = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
  csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
  await csRepo.add({ contractId, serviceCatalogId: catalog.id });
}

describe('TerminatePppoeService — mikrotik_radius path', () => {
  it('llama orchestrator.deleteUser y establece status=terminated + remoteAddress=null', async () => {
    const { pppoeRepo, orchestrator, svc } = buildDeps();
    const row = await pppoeRepo.upsertByUsername({
      username: 'client1', password: 'pwd', nasId: NAS_RADIUS_ID, contractId: CONTRACT_ID,
      status: 'enabled', remoteAddress: '100.64.1.1',
    });

    await svc.execute(row.id);

    // Orquestador recibió deleteUser
    const ops = orchestrator.opsFor('client1');
    expect(ops).toContain('deleteUser');

    // DB actualizada: terminated + IP liberada
    const updated = await pppoeRepo.findById(row.id);
    expect(updated!.status).toBe('terminated');
    expect(updated!.remoteAddress).toBeNull();
  });

  it('kickea la sesión live best-effort (disconnectSessions) después de deleteUser', async () => {
    const { pppoeRepo, orchestrator, svc } = buildDeps();
    const row = await pppoeRepo.upsertByUsername({
      username: 'client2', password: 'pwd', nasId: NAS_RADIUS_ID, contractId: CONTRACT_ID, status: 'enabled',
    });

    await svc.execute(row.id);

    const ops = orchestrator.opsFor('client2');
    expect(ops).toContain('deleteUser');
    expect(ops).toContain('disconnectSessions');
  });

  it('registra evento ensureInternet(false) con el reason dado', async () => {
    const { pppoeRepo, csRepo, catalogRepo, eventRepo, svc } = buildDeps();
    await seedInternetLine(csRepo, catalogRepo, CONTRACT_ID);
    const row = await pppoeRepo.upsertByUsername({
      username: 'client3', password: 'pwd', nasId: NAS_RADIUS_ID, contractId: CONTRACT_ID, status: 'enabled',
    });

    await svc.execute(row.id, { reason: 'baja definitiva', actorId: 'admin-1', actorName: 'Admin' });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.eventType).toBe('deactivated');
    expect(events[0]!.reason).toBe('baja definitiva');
  });

  it('deleteUser lanza OrchestratorUnreachableError → DB NO se modifica', async () => {
    const { pppoeRepo, svc } = buildDeps({ orchestratorUnreachable: ['client-fail'] });
    const row = await pppoeRepo.upsertByUsername({
      username: 'client-fail', password: 'pwd', nasId: NAS_RADIUS_ID, status: 'enabled',
    });

    await expect(svc.execute(row.id)).rejects.toThrow();

    // La fila NO debe haber cambiado
    const unchanged = await pppoeRepo.findById(row.id);
    expect(unchanged!.status).toBe('enabled');
  });

  it('deleteUser 404 (user ya borrado del RADIUS) → idempotente: marca terminated igual', async () => {
    const { pppoeRepo, orchestrator, svc } = buildDeps();
    // Doble-baja: el user ya no existe en RADIUS → el orchestrator responde 404.
    orchestrator.deleteUser = async () => {
      throw new OrchestratorRejectedError(404, { detail: 'user not found' });
    };
    const row = await pppoeRepo.upsertByUsername({
      username: 'client-gone', password: 'pwd', nasId: NAS_RADIUS_ID, contractId: CONTRACT_ID,
      status: 'enabled', remoteAddress: '100.64.1.9',
    });

    await svc.execute(row.id); // NO debe tirar 500

    const updated = await pppoeRepo.findById(row.id);
    expect(updated!.status).toBe('terminated');
    expect(updated!.remoteAddress).toBeNull();
  });

  it('falla con PppoeServiceNotFoundError para ID inexistente', async () => {
    const { svc } = buildDeps();
    await expect(svc.execute('non-existent')).rejects.toThrow(PppoeServiceNotFoundError);
  });
});

describe('TerminatePppoeService — non-radius path (mikrotik_api)', () => {
  it('llama router.removeSecret en vez de orchestrator.deleteUser', async () => {
    const { pppoeRepo, orchestrator, router, svc } = buildDeps();

    // Seed el secret en el router (NAS id=1 → ipAddress='192.168.1.1')
    await router.createSecret({ ipAddress: '192.168.1.1', apiPort: 8728 }, {
      username: 'api-client', password: 'pwd',
    });

    const row = await pppoeRepo.upsertByUsername({
      username: 'api-client', password: 'pwd', nasId: NAS_API_ID, status: 'enabled',
    });

    await svc.execute(row.id);

    // No va al orchestrator
    const orchestratorOps = orchestrator.opsFor('api-client');
    expect(orchestratorOps).not.toContain('deleteUser');

    // El secret fue removido del router (removeSecret fue llamado)
    const secrets = await router.listSecrets({ ipAddress: '192.168.1.1', apiPort: 8728 });
    expect(secrets.find(s => s.username === 'api-client')).toBeUndefined();

    // DB actualizada
    const updated = await pppoeRepo.findById(row.id);
    expect(updated!.status).toBe('terminated');
  });
});
