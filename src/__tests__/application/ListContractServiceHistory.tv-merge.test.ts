/**
 * #131 -- ListContractServiceHistory: TV merge fix (PARTE A read-side).
 *
 * BUG A: TV rows where event landed in CSE show actorName empty (TV branch only read tvEventRepo).
 * BUG B: Same rows show createdAt of the CS row instead of the real event date.
 *
 * FIX: for TV rows merge events from BOTH sources; synthesize only when both are empty.
 */
import { ListContractServiceHistory } from '@application/use-cases/ListContractServiceHistory';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';

function seedTvCatalog(csRepo: InMemoryContractServiceRepository): string {
  const catId = 'catTV-131';
  csRepo.catalog[catId] = { name: 'TV', label: 'TV' };
  return catId;
}

describe('ListContractServiceHistory -- #131 TV merge (CSE + tvActivationEvents)', () => {
  it('T-131-A: TV fila con eventos SOLO en CSE muestra actorName y fecha reales', async () => {
    const csRepo      = new InMemoryContractServiceRepository();
    const catId       = seedTvCatalog(csRepo);
    const tvRow       = await csRepo.add({ contractId: 'C-131', serviceCatalogId: catId, tvLogin: 'GIGA001', tvPassword: 'secret' });
    const eventDate   = new Date('2026-07-10T15:00:00Z');
    const cseRepo     = new InMemoryContractServiceEventRepository({ now: () => eventDate });
    await cseRepo.record({ contractId: 'C-131', serviceCatalogId: catId, eventType: 'deactivated', actorId: 'actor-131', actorName: 'jgomez', reason: 'baja voluntaria' });
    const tvEventRepo = new InMemoryTvActivationEventRepository();
    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C-131');
    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.id).toBe(tvRow.id);
    expect(item.events).toHaveLength(1);
    expect(item.events[0]!.eventType).toBe('deactivated');
    expect(item.events[0]!.actorName).toBe('jgomez');
    expect(item.events[0]!.occurredAt).toBe(eventDate.toISOString());
    expect(item.events[0]!.reason).toBe('baja voluntaria');
  });

  it('T-131-B: TV fila con eventos SOLO en tvActivationEvents no regresiona', async () => {
    const csRepo      = new InMemoryContractServiceRepository();
    const catId       = seedTvCatalog(csRepo);
    await csRepo.add({ contractId: 'C-131B', serviceCatalogId: catId, tvLogin: 'GIGA002', tvPassword: 'secret2' });
    const altaDate    = new Date('2026-07-05T10:00:00Z');
    const tvEventRepo = new InMemoryTvActivationEventRepository({ now: () => altaDate });
    await tvEventRepo.record({ clientId: 'CLI', contractId: 'C-131B', actorId: 'actor-B', actorName: 'mlopez', eventType: 'alta', cic: 'CIC002' });
    const cseRepo     = new InMemoryContractServiceEventRepository();
    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C-131B');
    expect(result).toHaveLength(1);
    expect(result[0]!.events[0]!.eventType).toBe('activated');
    expect(result[0]!.events[0]!.actorName).toBe('mlopez');
    expect(result[0]!.events[0]!.cic).toBe('CIC002');
    expect(result[0]!.events[0]!.occurredAt).toBe(altaDate.toISOString());
  });

  it('T-131-C: TV fila con eventos en AMBAS fuentes los mergea y ordena ASC', async () => {
    const csRepo      = new InMemoryContractServiceRepository();
    const catId       = seedTvCatalog(csRepo);
    await csRepo.add({ contractId: 'C-131C', serviceCatalogId: catId, tvLogin: 'GIGA003', tvPassword: 'secret3' });
    const t1          = new Date('2026-07-01T08:00:00Z');
    const tvEventRepo = new InMemoryTvActivationEventRepository({ now: () => t1 });
    await tvEventRepo.record({ clientId: 'CLI', contractId: 'C-131C', actorId: null, actorName: 'sys', eventType: 'alta', cic: 'CIC003' });
    const t2          = new Date('2026-07-15T09:00:00Z');
    const cseRepo     = new InMemoryContractServiceEventRepository({ now: () => t2 });
    await cseRepo.record({ contractId: 'C-131C', serviceCatalogId: catId, eventType: 'deactivated', actorId: 'actor-C', actorName: 'rperez', reason: 'mudanza' });
    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C-131C');
    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.events).toHaveLength(2);
    expect(item.events[0]!.eventType).toBe('activated');
    expect(item.events[0]!.actorName).toBe('sys');
    expect(item.events[0]!.cic).toBe('CIC003');
    expect(item.events[1]!.eventType).toBe('deactivated');
    expect(item.events[1]!.actorName).toBe('rperez');
    expect(item.events[1]!.reason).toBe('mudanza');
    expect(item.events[1]!.cic).toBeNull();
  });

  it('T-131-D: TV fila sin eventos en ninguna fuente usa sintesis legacy (actorName vacio)', async () => {
    const csRepo      = new InMemoryContractServiceRepository();
    const catId       = seedTvCatalog(csRepo);
    const tvRow       = await csRepo.add({ contractId: 'C-131D', serviceCatalogId: catId, tvLogin: 'GIGA004', tvPassword: 'secret4' });
    const tvEventRepo = new InMemoryTvActivationEventRepository();
    const cseRepo     = new InMemoryContractServiceEventRepository();
    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C-131D');
    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.events).toHaveLength(1);
    expect(item.events[0]!.eventType).toBe('activated');
    expect(item.events[0]!.actorName).toBe('');
    expect(item.events[0]!.occurredAt).toBe(tvRow.createdAt);
  });
});
