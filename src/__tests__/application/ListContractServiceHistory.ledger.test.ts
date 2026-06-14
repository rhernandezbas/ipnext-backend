/**
 * #110 — ListContractServiceHistory ledger extension tests.
 * Verifies the cross-source event assembly: non-TV reads CSE repo, TV reads TvActivationEvent repo.
 * Scenarios: R1.1 (3 events asc), R1.2 (TV cross, no generic), R1.3 (legacy synthesis), R1.4 (no tvPassword).
 */
import { ListContractServiceHistory } from '@application/use-cases/ListContractServiceHistory';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';

async function makeRepos() {
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const csRepo      = new InMemoryContractServiceRepository();
  const cseRepo     = new InMemoryContractServiceEventRepository();
  const tvEventRepo = new InMemoryTvActivationEventRepository();
  const cat         = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 0 });
  csRepo.catalog[cat.id] = { name: cat.name, label: cat.label };
  return { csRepo, cseRepo, tvEventRepo, catId: cat.id };
}

describe('ListContractServiceHistory — #110 ledger extension', () => {
  // R1.1 — non-TV service with 3 events returns them ordered ASC
  it('R1.1 non-TV: 3 events in chronological ASC order', async () => {
    const { csRepo, cseRepo, tvEventRepo, catId } = await makeRepos();
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: catId });

    // Record with deterministic ordering via timestamps
    const t0 = new Date('2026-07-01T08:00:00Z');
    const t1 = new Date('2026-07-02T08:00:00Z');
    const t2 = new Date('2026-07-03T08:00:00Z');

    const cseNow = [t0, t1, t2];
    let tick = 0;
    const cseRepoOrdered = new InMemoryContractServiceEventRepository({ now: () => cseNow[tick++]! });

    await cseRepoOrdered.record({ contractId: 'C', serviceCatalogId: catId, eventType: 'activated',   actorName: 'alice' });
    await cseRepoOrdered.record({ contractId: 'C', serviceCatalogId: catId, eventType: 'deactivated', actorName: 'bob'   });
    await cseRepoOrdered.record({ contractId: 'C', serviceCatalogId: catId, eventType: 'reactivated', actorName: 'alice' });

    const uc = new ListContractServiceHistory(csRepo, cseRepoOrdered, tvEventRepo);
    const result = await uc.execute('C');

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.id).toBe(svc.id);
    expect(item.events).toHaveLength(3);
    // chronological ASC: activated → deactivated → reactivated
    expect(item.events[0]!.eventType).toBe('activated');
    expect(item.events[1]!.eventType).toBe('deactivated');
    expect(item.events[2]!.eventType).toBe('reactivated');
    expect(item.events[0]!.cic).toBeNull();
  });

  // R1.2 — TV service reads tv_activation_events, NOT the generic CSE repo
  it('R1.2 TV: crosses tv_activation_events by contractId, cic preserved', async () => {
    const { csRepo, cseRepo, catId } = await makeRepos();
    // Add TV service with tvLogin set
    csRepo.catalog['catTV'] = { name: 'TV', label: 'TV' };
    const tvSvc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'catTV', tvLogin: 'GIGA001', tvPassword: 'secret' });

    // Add events in tvEventRepo for this contractId
    const t0 = new Date('2026-07-01T08:00:00Z');
    const t1 = new Date('2026-07-02T08:00:00Z');
    let tick = 0;
    const tvRepo = new InMemoryTvActivationEventRepository({ now: () => [t0, t1][tick++]! });
    await tvRepo.record({ clientId: 'CLI', contractId: 'C', actorId: null, actorName: 'sys', eventType: 'alta',  cic: 'CIC001' });
    await tvRepo.record({ clientId: 'CLI', contractId: 'C', actorId: null, actorName: 'sys', eventType: 'baja',  cic: 'CIC001' });

    // Add a stray generic event in cseRepo — must NOT appear in TV item
    await cseRepo.record({ contractId: 'C', serviceCatalogId: 'catTV', eventType: 'activated' });

    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvRepo);
    const result = await uc.execute('C');
    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.id).toBe(tvSvc.id);
    expect(item.events).toHaveLength(2);
    // alta → activated; baja → deactivated; order ASC
    expect(item.events[0]!.eventType).toBe('activated');
    expect(item.events[1]!.eventType).toBe('deactivated');
    expect(item.events[0]!.cic).toBe('CIC001');
    expect(item.events[1]!.cic).toBe('CIC001');
  });

  // R1.3 — legacy: service with no events synthesizes activated + optional deactivated
  it('R1.3 legacy active service with no events → synthesized activated', async () => {
    const { csRepo, cseRepo, tvEventRepo, catId } = await makeRepos();
    await csRepo.add({ contractId: 'C', serviceCatalogId: catId });

    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C');
    expect(result[0]!.events).toHaveLength(1);
    expect(result[0]!.events[0]!.eventType).toBe('activated');
    expect(result[0]!.events[0]!.cic).toBeNull();
    // occurredAt should match createdAt of the service
    expect(result[0]!.events[0]!.occurredAt).toBe(result[0]!.createdAt);
  });

  it('R1.3 legacy inactive service with no events → synthesized activated + deactivated', async () => {
    const { csRepo, cseRepo, tvEventRepo, catId } = await makeRepos();
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: catId });
    await csRepo.update(svc.id, { status: 'inactive' });

    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C');
    expect(result[0]!.events).toHaveLength(2);
    expect(result[0]!.events[0]!.eventType).toBe('activated');
    expect(result[0]!.events[1]!.eventType).toBe('deactivated');
    // deactivated occurredAt = deactivatedAt
    expect(result[0]!.events[1]!.occurredAt).toBe(result[0]!.deactivatedAt);
  });

  // R1.4 — tvPassword must NEVER appear in result
  it('R1.4 tvPassword is absent from ALL events and items', async () => {
    const { csRepo, cseRepo, tvEventRepo, catId } = await makeRepos();
    csRepo.catalog['catTV'] = { name: 'TV', label: 'TV' };
    await csRepo.add({ contractId: 'C', serviceCatalogId: 'catTV', tvLogin: 'GIGA001', tvPassword: 'SECRET_PW' });

    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C');
    const json = JSON.stringify(result);
    expect(json).not.toContain('tvPassword');
    expect(json).not.toContain('SECRET_PW');
  });

  // backward-compat: old call-site that only passes csRepo still works (legacy #73 tests)
  it('backward compat: no events repos → synthesizes events for all services', async () => {
    const { csRepo, catId } = await makeRepos();
    await csRepo.add({ contractId: 'C', serviceCatalogId: catId });
    const uc = new ListContractServiceHistory(csRepo);
    const result = await uc.execute('C');
    expect(result).toHaveLength(1);
    // Should still return an events array (synthesized)
    expect(Array.isArray(result[0]!.events)).toBe(true);
  });

  // W-1 — TV legacy: service with tvLogin but NO tv_activation_events → synthesizes activated
  it('W-1 TV legacy: tvLogin set but no tv_activation_events → synthesized activated event', async () => {
    const { csRepo, cseRepo } = await makeRepos();
    // TV service (tvLogin set)
    csRepo.catalog['catTV'] = { name: 'TV', label: 'TV' };
    await csRepo.add({ contractId: 'C', serviceCatalogId: 'catTV', tvLogin: 'GIGA001', tvPassword: 'secret' });

    // Empty tvEventRepo — no rows in tv_activation_events for this contract
    const emptyTvRepo = new InMemoryTvActivationEventRepository();

    const uc = new ListContractServiceHistory(csRepo, cseRepo, emptyTvRepo);
    const result = await uc.execute('C');
    expect(result).toHaveLength(1);
    const item = result[0]!;
    // Must NOT be empty — spec R1.3: modal always shows at least the alta
    expect(item.events).toHaveLength(1);
    expect(item.events[0]!.eventType).toBe('activated');
    expect(item.events[0]!.cic).toBeNull();
    // occurredAt must match the service's createdAt
    expect(item.events[0]!.occurredAt).toBe(item.createdAt);
  });

  // FF-1 — supuesto 1 TV por contrato: 1 TV service + 1 non-TV each gets their own events
  it('FF-1 multi-service: TV gets tvEvents, non-TV gets its own cseEvents (1-TV assumption pinned)', async () => {
    const { csRepo, catId } = await makeRepos();
    // Non-TV service
    const nonTvSvc = await csRepo.add({ contractId: 'C', serviceCatalogId: catId });
    // TV service
    csRepo.catalog['catTV'] = { name: 'TV', label: 'TV' };
    const tvSvc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'catTV', tvLogin: 'GIGA001', tvPassword: 'secret' });

    // CSE events for the non-TV service only
    const t0 = new Date('2026-07-01T08:00:00Z');
    let cseTick = 0;
    const cseRepo = new InMemoryContractServiceEventRepository({ now: () => cseTick++ === 0 ? t0 : new Date() });
    await cseRepo.record({ contractId: 'C', serviceCatalogId: catId, eventType: 'activated', actorName: 'sys' });

    // TV activation events for the contract
    const t1 = new Date('2026-07-02T08:00:00Z');
    const t2 = new Date('2026-07-03T08:00:00Z');
    let tvTick = 0;
    const tvRepo = new InMemoryTvActivationEventRepository({ now: () => [t1, t2][tvTick++]! });
    await tvRepo.record({ clientId: 'CLI', contractId: 'C', actorId: null, actorName: 'sys', eventType: 'alta', cic: 'CIC001' });
    await tvRepo.record({ clientId: 'CLI', contractId: 'C', actorId: null, actorName: 'sys', eventType: 'baja', cic: 'CIC001' });

    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvRepo);
    const result = await uc.execute('C');
    expect(result).toHaveLength(2);

    const nonTvItem = result.find(r => r.id === nonTvSvc.id)!;
    const tvItem    = result.find(r => r.id === tvSvc.id)!;

    // Non-TV: gets its CSE event (activated from cseRepo)
    expect(nonTvItem.events).toHaveLength(1);
    expect(nonTvItem.events[0]!.eventType).toBe('activated');
    expect(nonTvItem.events[0]!.cic).toBeNull();

    // TV: gets both tv_activation_events (alta → activated, baja → deactivated)
    expect(tvItem.events).toHaveLength(2);
    expect(tvItem.events[0]!.eventType).toBe('activated');
    expect(tvItem.events[1]!.eventType).toBe('deactivated');
    expect(tvItem.events[0]!.cic).toBe('CIC001');
  });
});
