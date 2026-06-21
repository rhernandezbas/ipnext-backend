/**
 * EnforcePppoeService.event.test.ts — TDD para la integración RecordPppoeEnforceEvent
 * dentro de EnforcePppoeService (pppoe-corte-individual).
 *
 * Cubre:
 *   - acción no-idempotente con { reason, actorId, actorName } → evento registrado
 *   - acción idempotente (ya en estado destino) → NO registra evento
 *   - pppoe sin contractId → no-op de evento (best-effort)
 */
import { EnforcePppoeService } from '@application/use-cases/EnforcePppoeService';
import { RecordPppoeEnforceEvent } from '@application/use-cases/RecordPppoeEnforceEvent';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { RouterOsEnforcementAdapter } from '@infrastructure/adapters/routeros/RouterOsEnforcementAdapter';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';

// InMemoryNasRepository preseeds id='1' con ip='192.168.1.1', type='mikrotik_api'
const NAS_ID = '1';
const NAS_IP = '192.168.1.1';

async function buildSut() {
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const routerGw = new InMemoryRouterGateway();
  const nasRepo = new InMemoryNasRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const eventRepo = new InMemoryContractServiceEventRepository();

  // seed catálogo INTERNET
  await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });

  const enforcement = new RouterOsEnforcementAdapter(routerGw, 'IP-REDUCCION');
  const recordEvent = new RecordPppoeEnforceEvent(catalogRepo, eventRepo);
  const sut = new EnforcePppoeService(pppoeRepo, enforcement, nasRepo, recordEvent);

  return { pppoeRepo, routerGw, eventRepo, sut };
}

describe('EnforcePppoeService — con RecordPppoeEnforceEvent (pppoe-corte-individual)', () => {
  it('acción no-idempotente con reason + actor → evento registrado', async () => {
    const { pppoeRepo, routerGw, eventRepo, sut } = await buildSut();

    const pppoe = await pppoeRepo.upsertByUsername({
      username: 'cli1',
      password: 'pw',
      nasId: NAS_ID,
      contractId: 'contract-1',
      status: 'enabled',
      enforcedState: 'active',
    });
    await routerGw.createSecret(
      { ipAddress: NAS_IP, apiPort: 8728 },
      { username: 'cli1', password: 'pw', profile: null },
    );

    await sut.execute({
      id: pppoe.id,
      action: 'reduce',
      reason: 'deuda',
      actorId: 'user-1',
      actorName: 'Admin',
    });

    const events = await eventRepo.listByContract('contract-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('reduced');
    expect(events[0]!.reason).toBe('deuda');
    expect(events[0]!.actorId).toBe('user-1');
    expect(events[0]!.actorName).toBe('Admin');
  });

  it('acción idempotente (ya en estado destino) → NO registra evento', async () => {
    const { pppoeRepo, eventRepo, sut } = await buildSut();

    // Ya está en 'reduced' — reduce de nuevo es no-op
    const pppoe = await pppoeRepo.upsertByUsername({
      username: 'cli2',
      password: 'pw',
      nasId: NAS_ID,
      contractId: 'contract-2',
      status: 'enabled',
      enforcedState: 'reduced',
    });

    await sut.execute({
      id: pppoe.id,
      action: 'reduce',
      reason: 'deuda',
      actorName: 'Admin',
    });

    const events = await eventRepo.listByContract('contract-2');
    expect(events).toHaveLength(0);
  });

  it('pppoe sin contractId → enforcement OK, no hay evento', async () => {
    const { pppoeRepo, routerGw, eventRepo, sut } = await buildSut();

    const pppoe = await pppoeRepo.upsertByUsername({
      username: 'orphan',
      password: 'pw',
      nasId: NAS_ID,
      contractId: null,
      status: 'enabled',
      enforcedState: 'active',
    });
    await routerGw.createSecret(
      { ipAddress: NAS_IP, apiPort: 8728 },
      { username: 'orphan', password: 'pw', profile: null },
    );

    // No debe tirar; contractId=null → RecordPppoeEnforceEvent no se invoca
    await expect(sut.execute({ id: pppoe.id, action: 'reduce', actorName: 'Admin' })).resolves.toBeTruthy();

    expect(eventRepo.all()).toHaveLength(0);
  });
});
