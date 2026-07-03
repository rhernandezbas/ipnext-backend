/**
 * #110 — InMemoryContractServiceEventRepository unit tests.
 * Verifies: record acumulates; listByContract newest-first; filters by contractId.
 */
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';

describe('InMemoryContractServiceEventRepository', () => {
  let repo: InMemoryContractServiceEventRepository;
  let now: Date;

  beforeEach(() => {
    now = new Date('2026-07-22T10:00:00Z');
    let tick = 0;
    repo = new InMemoryContractServiceEventRepository({ now: () => new Date(now.getTime() + tick++ * 1000) });
  });

  // R4.1a — record accumulates
  it('record stores events and listByContract returns them newest-first', async () => {
    await repo.record({ contractId: 'C', serviceCatalogId: 'S', eventType: 'activated', actorName: 'alice' });
    await repo.record({ contractId: 'C', serviceCatalogId: 'S', eventType: 'deactivated', actorName: 'bob' });
    await repo.record({ contractId: 'C', serviceCatalogId: 'S', eventType: 'reactivated', actorName: 'alice' });

    const events = await repo.listByContract('C');
    expect(events).toHaveLength(3);
    // newest-first: reactivated → deactivated → activated
    expect(events[0]!.eventType).toBe('reactivated');
    expect(events[1]!.eventType).toBe('deactivated');
    expect(events[2]!.eventType).toBe('activated');
  });

  // R4.1b — filters by contractId
  it('listByContract only returns events for the given contractId', async () => {
    await repo.record({ contractId: 'C', serviceCatalogId: 'S', eventType: 'activated' });
    await repo.record({ contractId: 'OTHER', serviceCatalogId: 'S2', eventType: 'activated' });

    const events = await repo.listByContract('C');
    expect(events).toHaveLength(1);
    expect(events[0]!.contractId).toBe('C');
  });

  // R4.1c — record returns the saved event
  it('record returns the created event with all fields', async () => {
    const ev = await repo.record({
      contractId: 'C',
      serviceCatalogId: 'S',
      eventType: 'activated',
      actorId: 'user1',
      actorName: 'Alice',
      notes: 'initial',
    });

    expect(ev.id).toBeDefined();
    expect(ev.contractId).toBe('C');
    expect(ev.serviceCatalogId).toBe('S');
    expect(ev.eventType).toBe('activated');
    expect(ev.actorId).toBe('user1');
    expect(ev.actorName).toBe('Alice');
    expect(ev.notes).toBe('initial');
    expect(typeof ev.createdAt).toBe('string');
  });

  // R4.1d — actorName defaults to '' when not provided
  it('actorName defaults to empty string when not provided', async () => {
    const ev = await repo.record({ contractId: 'C', serviceCatalogId: 'S', eventType: 'activated' });
    expect(ev.actorName).toBe('');
    expect(ev.actorId).toBeNull();
  });

  // R4.1e — all() helper for test assertions
  it('all() exposes all stored events unfiltered', async () => {
    await repo.record({ contractId: 'C', serviceCatalogId: 'S', eventType: 'activated' });
    await repo.record({ contractId: 'D', serviceCatalogId: 'S', eventType: 'activated' });
    expect(repo.all()).toHaveLength(2);
  });

  // internet-history-plan-direction — oldPlan/newPlan round-trip + eventType push-down filter
  it('record persists oldPlan/newPlan and returns them (null by default)', async () => {
    const withPlans = await repo.record({
      contractId: 'C', serviceCatalogId: 'S', eventType: 'modified',
      oldPlan: 'IP-30M', newPlan: 'IP-50M',
    });
    expect(withPlans.oldPlan).toBe('IP-30M');
    expect(withPlans.newPlan).toBe('IP-50M');

    const noPlans = await repo.record({ contractId: 'C', serviceCatalogId: 'S', eventType: 'activated' });
    expect(noPlans.oldPlan).toBeNull();
    expect(noPlans.newPlan).toBeNull();
  });

  it('list filters by eventType (tópico) and carries oldPlan/newPlan through', async () => {
    await repo.record({ contractId: 'C', serviceCatalogId: 'S', eventType: 'activated' });
    await repo.record({ contractId: 'C', serviceCatalogId: 'S', eventType: 'modified', oldPlan: 'IP-30M', newPlan: 'IP-50M' });

    const modified = await repo.list({ serviceCatalogId: 'S', eventType: 'modified' });
    expect(modified).toHaveLength(1);
    expect(modified[0]!.eventType).toBe('modified');
    expect(modified[0]!.oldPlan).toBe('IP-30M');
    expect(modified[0]!.newPlan).toBe('IP-50M');
  });
});
