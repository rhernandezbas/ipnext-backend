/**
 * #117 — ListContractServiceHistory: operador (actorName) presente en eventos del historial.
 *
 * Escenarios del plan:
 *   T1: evento con actorName:"jperez" → item.events[].actorName === "jperez"
 *   T2: tvPassword ausente de la respuesta (aplica tanto para CSE como TV)
 *   T6: síntesis legacy → actorName:"" (no se inventa operador)
 *
 * Usa InMemory repos (TDD estricto: sin DB, sin Prisma).
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

describe('ListContractServiceHistory — #117 operador en eventos', () => {
  // T1 — CSE: evento con actorName:"jperez" → actorName propagado en el item
  it('T1 non-TV: evento con actorName:"jperez" → events[].actorName === "jperez"', async () => {
    const { csRepo, cseRepo, tvEventRepo, catId } = await makeRepos();
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: catId });
    await cseRepo.record({
      contractId:       'C',
      serviceCatalogId: catId,
      eventType:        'activated',
      actorName:        'jperez',
    });

    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C');

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.id).toBe(svc.id);
    expect(item.events).toHaveLength(1);
    expect(item.events[0]!.actorName).toBe('jperez');
  });

  // T1 TV: evento TV con actorName:"jperez" → actorName propagado
  it('T1 TV: evento TV con actorName:"jperez" → events[].actorName === "jperez"', async () => {
    const { csRepo, cseRepo, tvEventRepo } = await makeRepos();
    csRepo.catalog['catTV'] = { name: 'TV', label: 'TV' };
    const tvSvc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'catTV', tvLogin: 'GIGA001', tvPassword: 'secret' });

    await tvEventRepo.record({
      clientId:   'CLI',
      contractId: 'C',
      actorId:    null,
      actorName:  'jperez',
      eventType:  'alta',
      cic:        'CIC001',
    });

    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C');

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.id).toBe(tvSvc.id);
    expect(item.events).toHaveLength(1);
    expect(item.events[0]!.actorName).toBe('jperez');
  });

  // T2 — tvPassword ausente en la respuesta cuando hay eventos con actorName
  it('T2: tvPassword ausente de la respuesta cuando hay eventos TV con actorName', async () => {
    const { csRepo, cseRepo, tvEventRepo } = await makeRepos();
    csRepo.catalog['catTV'] = { name: 'TV', label: 'TV' };
    await csRepo.add({ contractId: 'C', serviceCatalogId: 'catTV', tvLogin: 'GIGA001', tvPassword: 'SECRET_PW' });

    await tvEventRepo.record({
      clientId:   'CLI',
      contractId: 'C',
      actorId:    null,
      actorName:  'jperez',
      eventType:  'alta',
      cic:        'CIC001',
    });

    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C');

    const json = JSON.stringify(result);
    expect(json).not.toContain('tvPassword');
    expect(json).not.toContain('SECRET_PW');
    // actorName sí debe estar
    expect(result[0]!.events[0]!.actorName).toBe('jperez');
  });

  // T6 — servicio SIN eventos → síntesis legacy con actorName:'' (no se inventa operador)
  it('T6 non-TV sin eventos → síntesis legacy con actorName:""', async () => {
    const { csRepo, cseRepo, tvEventRepo, catId } = await makeRepos();
    await csRepo.add({ contractId: 'C', serviceCatalogId: catId });

    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C');

    expect(result).toHaveLength(1);
    expect(result[0]!.events).toHaveLength(1);
    expect(result[0]!.events[0]!.eventType).toBe('activated');
    // La síntesis no inventa operador — actorName debe ser ''
    expect(result[0]!.events[0]!.actorName).toBe('');
  });

  // T6 TV sin eventos → síntesis legacy con actorName:''
  it('T6 TV sin eventos → síntesis legacy con actorName:""', async () => {
    const { csRepo, cseRepo } = await makeRepos();
    csRepo.catalog['catTV'] = { name: 'TV', label: 'TV' };
    await csRepo.add({ contractId: 'C', serviceCatalogId: 'catTV', tvLogin: 'GIGA001', tvPassword: 'secret' });

    const emptyTvRepo = new InMemoryTvActivationEventRepository();
    const uc = new ListContractServiceHistory(csRepo, cseRepo, emptyTvRepo);
    const result = await uc.execute('C');

    expect(result).toHaveLength(1);
    expect(result[0]!.events).toHaveLength(1);
    expect(result[0]!.events[0]!.actorName).toBe('');
  });

  // Paridad adapter: InMemory devuelve el actorName sembrado directamente (sin JOIN)
  it('Paridad: InMemory devuelve el actorName sembrado (el JOIN es exclusivo del adapter Prisma)', async () => {
    const { csRepo, cseRepo, tvEventRepo, catId } = await makeRepos();
    await csRepo.add({ contractId: 'C', serviceCatalogId: catId });

    // Sembrar evento con actorName vacío y actorId (simula evento viejo con fila)
    // El InMemory NO resuelve actorId → login: devuelve '' como está sembrado
    await cseRepo.record({
      contractId:       'C',
      serviceCatalogId: catId,
      eventType:        'activated',
      actorId:          'some-user-id',
      actorName:        '',
    });

    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C');

    // InMemory no tiene JOIN, así que devuelve '' (el snapshot vacío)
    // Este es el comportamiento ESPERADO y documentado para el in-memory
    expect(result[0]!.events[0]!.actorName).toBe('');
  });
});
