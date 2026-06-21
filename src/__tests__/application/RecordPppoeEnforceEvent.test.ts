/**
 * RecordPppoeEnforceEvent.test.ts — TDD RED→GREEN para el use case de registro de eventos
 * de enforcement PPPoE (pppoe-corte-individual).
 *
 * Cubre:
 *   - reduce → registra evento 'reduced' con reason + actor
 *   - block  → registra evento 'blocked' con reason + actor
 *   - restore → registra evento 'restored' con reason + actor
 *   - catalogRepo retorna null → no-op (sin tirar)
 *   - eventRepo.record lanza → execute NO tira (best-effort)
 */
import { RecordPppoeEnforceEvent } from '@application/use-cases/RecordPppoeEnforceEvent';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';

describe('RecordPppoeEnforceEvent', () => {
  async function buildWithCatalog() {
    const catalogRepo = new InMemoryServiceCatalogRepository();
    const catalog = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
    const eventRepo = new InMemoryContractServiceEventRepository();
    const uc = new RecordPppoeEnforceEvent(catalogRepo, eventRepo);
    return { catalogRepo, eventRepo, uc, catalog };
  }

  it('reduce → registra evento reduced con reason y actor', async () => {
    const { eventRepo, uc } = await buildWithCatalog();

    await uc.execute('contract-1', 'reduce', {
      reason: 'deuda pendiente',
      actorId: 'user-1',
      actorName: 'Admin',
    });

    const events = await eventRepo.listByContract('contract-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('reduced');
    expect(events[0]!.reason).toBe('deuda pendiente');
    expect(events[0]!.actorId).toBe('user-1');
    expect(events[0]!.actorName).toBe('Admin');
  });

  it('block → registra evento blocked', async () => {
    const { eventRepo, uc } = await buildWithCatalog();

    await uc.execute('contract-2', 'block', {
      reason: 'mora extendida',
      actorId: 'user-2',
      actorName: 'Supervisor',
    });

    const events = await eventRepo.listByContract('contract-2');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('blocked');
    expect(events[0]!.reason).toBe('mora extendida');
  });

  it('restore → registra evento restored', async () => {
    const { eventRepo, uc } = await buildWithCatalog();

    await uc.execute('contract-3', 'restore', {
      reason: 'pago recibido',
      actorId: 'user-3',
      actorName: 'Cajero',
    });

    const events = await eventRepo.listByContract('contract-3');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('restored');
    expect(events[0]!.reason).toBe('pago recibido');
  });

  it('sin catálogo INTERNET → no-op (no tira, no registra evento)', async () => {
    const catalogRepo = new InMemoryServiceCatalogRepository(); // vacío
    const eventRepo = new InMemoryContractServiceEventRepository();
    const uc = new RecordPppoeEnforceEvent(catalogRepo, eventRepo);

    await expect(uc.execute('contract-x', 'reduce', { actorName: 'Admin' })).resolves.toBeUndefined();

    expect(eventRepo.all()).toHaveLength(0);
  });

  it('eventRepo.record lanza → execute NO tira (best-effort)', async () => {
    const catalogRepo = new InMemoryServiceCatalogRepository();
    await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });

    const eventRepo = new InMemoryContractServiceEventRepository();
    // Sobreescribir record para que tire
    jest.spyOn(eventRepo, 'record').mockRejectedValueOnce(new Error('DB exploded'));

    const uc = new RecordPppoeEnforceEvent(catalogRepo, eventRepo);

    // NO debe tirar
    await expect(uc.execute('contract-y', 'block', { actorName: 'Admin' })).resolves.toBeUndefined();
  });

  it('reason null → se registra con reason null', async () => {
    const { eventRepo, uc } = await buildWithCatalog();

    await uc.execute('contract-4', 'reduce', { reason: null, actorName: 'Bot' });

    const events = await eventRepo.listByContract('contract-4');
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBeNull();
  });
});
