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

/**
 * #135 rev -- ListContractServiceHistory: isTvRow predicate hardened.
 *
 * PROBLEMA ORIGINAL (#135): cuando se da de baja la TV, reconcileTvContractService limpia
 * tvLogin: null. El use case detectaba TV SOLO via tvLogin !== null -> tras la baja, la fila
 * caia en rama NO-TV y usaba sintesis legacy con actorName vacio.
 *
 * FIX ORIGINAL (fragil): detectar TV por notes.startsWith('CIC ') cuando tvLogin es null.
 * PROBLEMA DEL FIX: fila no-TV (name='Internet') con notes='CIC 000123 pending' era falso positivo.
 *
 * FIX DEFINITIVO (#135 rev): usar senales estructurales:
 *   isTvRow(view) = view.tvLogin !== null || view.name === 'TV'
 * - tvLogin !== null -> TV activa
 * - name === 'TV'   -> identidad del catalogo (estable, no cambia con bajas)
 * No depende de notas de texto libre.
 */
describe('ListContractServiceHistory -- #135 rev isTvRow via name=TV (no notes)', () => {
  function seedTvCatalog135(csRepo: InMemoryContractServiceRepository): string {
    const catId = 'catTV-135';
    csRepo.catalog[catId] = { name: 'TV', label: 'TV' };
    return catId;
  }

  // T-135-1: fila TV dada de baja (status=inactive, tvLogin=null, name='TV') con eventos alta+baja
  // en tv_activation_events -> muestra CON operador y motivo (name='TV' es la senal, no notes)
  it('T-135-1: TV dada de baja (tvLogin=null, name=TV) muestra eventos con actorName y reason reales', async () => {
    const csRepo      = new InMemoryContractServiceRepository();
    const catId       = seedTvCatalog135(csRepo);
    const tvRow       = await csRepo.add({
      contractId:       'C-135',
      serviceCatalogId: catId,
      tvLogin:          null,
      notes:            null,
    });
    await csRepo.update(tvRow.id, { status: 'inactive' });

    const altaDate  = new Date('2026-05-01T10:00:00Z');
    const bajaDate  = new Date('2026-06-15T14:30:00Z');
    let tvTick      = 0;
    const tvEventRepo = new InMemoryTvActivationEventRepository({ now: () => [altaDate, bajaDate][tvTick++]! });
    await tvEventRepo.record({ clientId: 'CLI-135', contractId: 'C-135', actorId: 'a1', actorName: 'mlopez', eventType: 'alta',  cic: 'CIC 0006651547' });
    await tvEventRepo.record({ clientId: 'CLI-135', contractId: 'C-135', actorId: 'a2', actorName: 'jperez', eventType: 'baja',  cic: 'CIC 0006651547' });

    const cseRepo = new InMemoryContractServiceEventRepository();
    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C-135');

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.id).toBe(tvRow.id);
    expect(item.status).toBe('inactive');
    expect(item.events).toHaveLength(2);
    expect(item.events[0]!.eventType).toBe('activated');
    expect(item.events[0]!.actorName).toBe('mlopez');
    expect(item.events[0]!.actorName).not.toBe('');
    expect(item.events[1]!.eventType).toBe('deactivated');
    expect(item.events[1]!.actorName).toBe('jperez');
    expect(item.events[1]!.actorName).not.toBe('');
  });

  // T-135-2: no-regresion TV activa (tvLogin != null) sigue funcionando igual que antes
  it('T-135-2: TV activa (tvLogin != null) sigue detectandose como TV y cargando sus eventos', async () => {
    const csRepo      = new InMemoryContractServiceRepository();
    const catId       = seedTvCatalog135(csRepo);
    const tvRow       = await csRepo.add({
      contractId:       'C-135B',
      serviceCatalogId: catId,
      tvLogin:          'GIGA007',
      tvPassword:       'secret',
      notes:            null,
    });

    const altaDate    = new Date('2026-04-01T09:00:00Z');
    const tvEventRepo = new InMemoryTvActivationEventRepository({ now: () => altaDate });
    await tvEventRepo.record({ clientId: 'CLI-B', contractId: 'C-135B', actorId: 'a1', actorName: 'rsanchez', eventType: 'alta', cic: 'CIC007' });

    const cseRepo = new InMemoryContractServiceEventRepository();
    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C-135B');

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.id).toBe(tvRow.id);
    expect(item.events).toHaveLength(1);
    expect(item.events[0]!.eventType).toBe('activated');
    expect(item.events[0]!.actorName).toBe('rsanchez');
    expect(item.events[0]!.cic).toBe('CIC007');
  });

  // T-135-3: no-regresion NO-TV real (tvLogin=null, name != 'TV') NO se trata como TV
  it('T-135-3: fila NO-TV (tvLogin=null, name=INTERNET) va a rama no-TV / sintesis legacy', async () => {
    const csRepo  = new InMemoryContractServiceRepository();
    const catId   = 'catINTERNET-135';
    csRepo.catalog[catId] = { name: 'INTERNET', label: 'Internet' };
    const row = await csRepo.add({
      contractId:       'C-135C',
      serviceCatalogId: catId,
      tvLogin:          null,
      notes:            'Internet 100MB',
    });

    const cseRepo     = new InMemoryContractServiceEventRepository();
    const tvEventRepo = new InMemoryTvActivationEventRepository();
    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C-135C');

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.id).toBe(row.id);
    expect(item.events).toHaveLength(1);
    expect(item.events[0]!.eventType).toBe('activated');
    expect(item.events[0]!.actorName).toBe('');
  });

  // T-135-4: edge case -- fila TV (name='TV') inactiva sin eventos en ninguna fuente
  // -> sintesis legacy (no rompe, no tira excepcion)
  it('T-135-4: TV dada de baja (name=TV, tvLogin=null) sin eventos -> sintesis legacy (no rompe)', async () => {
    const csRepo      = new InMemoryContractServiceRepository();
    const catId       = seedTvCatalog135(csRepo);
    const tvRow       = await csRepo.add({
      contractId:       'C-135D',
      serviceCatalogId: catId,
      tvLogin:          null,
      notes:            null,
    });
    await csRepo.update(tvRow.id, { status: 'inactive' });

    const cseRepo     = new InMemoryContractServiceEventRepository();
    const tvEventRepo = new InMemoryTvActivationEventRepository();
    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C-135D');

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.events.length).toBeGreaterThanOrEqual(1);
    expect(item.events[0]!.eventType).toBe('activated');
    expect(item.events[0]!.actorName).toBe('');
  });

  // T-135-FP (CRITICAL-1 false positive): fila NO-TV (name='Internet') con notes='CIC 000123 pendiente'
  // -> NO debe tratarse como TV: va a rama no-TV, NO recibe tvEvents del contrato.
  it('T-135-FP: NO-TV (name=Internet, notes=CIC...) no contamina con tvEvents (falso positivo resuelto)', async () => {
    const csRepo  = new InMemoryContractServiceRepository();

    const catInternet = 'catINTERNET-FP';
    csRepo.catalog[catInternet] = { name: 'Internet', label: 'Internet' };
    const internetRow = await csRepo.add({
      contractId:       'C-135-FP',
      serviceCatalogId: catInternet,
      tvLogin:          null,
      notes:            'CIC 000123 pendiente',
    });

    // tvEventRepo tiene eventos -- si la rama no-TV los recibiera, seria un bug (falso positivo)
    const tvEventDate = new Date('2026-05-10T08:00:00Z');
    const tvEventRepo = new InMemoryTvActivationEventRepository({ now: () => tvEventDate });
    await tvEventRepo.record({ clientId: 'CLI-FP', contractId: 'C-135-FP', actorId: 'a1', actorName: 'fake', eventType: 'alta', cic: 'CIC 000123' });

    const cseRepo = new InMemoryContractServiceEventRepository();
    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C-135-FP');

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.id).toBe(internetRow.id);
    // Debe ir por la rama no-TV: sintesis legacy, NO tvEvents
    expect(item.events).toHaveLength(1);
    expect(item.events[0]!.eventType).toBe('activated');
    expect(item.events[0]!.actorName).toBe(''); // sintesis legacy, no recibio tvEvents
    expect(item.events[0]!.cic).toBeNull();      // sin cic, no proviene de tvActivationEvents
  });

  // T-135-FN (WARNING-1 false negative): fila TV (name='TV', tvLogin=null, notes=null) dada de baja
  // -> name='TV' es suficiente para detectarla como TV y mostrar eventos (falso negativo resuelto)
  it('T-135-FN: TV (name=TV, tvLogin=null, notes=null) muestra eventos via name signal (falso negativo resuelto)', async () => {
    const csRepo      = new InMemoryContractServiceRepository();
    const catId       = seedTvCatalog135(csRepo);
    const tvRow       = await csRepo.add({
      contractId:       'C-135-FN',
      serviceCatalogId: catId,
      tvLogin:          null,
      notes:            null,
    });
    await csRepo.update(tvRow.id, { status: 'inactive' });

    const bajaDate    = new Date('2026-06-20T11:00:00Z');
    const tvEventRepo = new InMemoryTvActivationEventRepository({ now: () => bajaDate });
    await tvEventRepo.record({ clientId: 'CLI-FN', contractId: 'C-135-FN', actorId: 'a2', actorName: 'rlopez', eventType: 'baja', cic: 'CIC 0009999' });

    const cseRepo = new InMemoryContractServiceEventRepository();
    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C-135-FN');

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.id).toBe(tvRow.id);
    // name='TV' detecta como TV -> recibe tvEvents
    expect(item.events).toHaveLength(1);
    expect(item.events[0]!.eventType).toBe('deactivated');
    expect(item.events[0]!.actorName).toBe('rlopez');
    expect(item.events[0]!.actorName).not.toBe('');
    expect(item.events[0]!.cic).toBe('CIC 0009999');
  });

  // T-135-CROSS (WARNING-2 cross-assignment): contrato con fila TV real (name='TV', baja) + fila NO-TV
  // (name='Internet', notes='CIC ...') -> tvEvents van SOLO a la fila TV; fila no-TV no los recibe.
  it('T-135-CROSS: tvEvents van solo a la fila TV; fila no-TV con notes CIC no los recibe', async () => {
    const csRepo = new InMemoryContractServiceRepository();

    // Fila TV (dada de baja: tvLogin=null, name='TV')
    const catTV = 'catTV-CROSS';
    csRepo.catalog[catTV] = { name: 'TV', label: 'TV' };
    const tvRow = await csRepo.add({
      contractId:       'C-135-CROSS',
      serviceCatalogId: catTV,
      tvLogin:          null,
      notes:            null,
    });
    await csRepo.update(tvRow.id, { status: 'inactive' });

    // Fila no-TV con notes que empiezan por 'CIC' (caso falso positivo del predicado viejo)
    const catInternet = 'catINTERNET-CROSS';
    csRepo.catalog[catInternet] = { name: 'Internet', label: 'Internet' };
    const internetRow = await csRepo.add({
      contractId:       'C-135-CROSS',
      serviceCatalogId: catInternet,
      tvLogin:          null,
      notes:            'CIC 000123 Internet',
    });

    // tvEvents del contrato (corresponden a la fila TV)
    const altaDate = new Date('2026-03-01T10:00:00Z');
    const bajaDate = new Date('2026-06-01T15:00:00Z');
    let tvTick = 0;
    const tvEventRepo = new InMemoryTvActivationEventRepository({ now: () => [altaDate, bajaDate][tvTick++]! });
    await tvEventRepo.record({ clientId: 'CLI-CROSS', contractId: 'C-135-CROSS', actorId: 'a1', actorName: 'mlopez', eventType: 'alta', cic: 'CIC TV' });
    await tvEventRepo.record({ clientId: 'CLI-CROSS', contractId: 'C-135-CROSS', actorId: 'a2', actorName: 'jperez', eventType: 'baja', cic: 'CIC TV' });

    const cseRepo = new InMemoryContractServiceEventRepository();
    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo);
    const result = await uc.execute('C-135-CROSS');

    expect(result).toHaveLength(2);
    const tvItem       = result.find(r => r.id === tvRow.id)!;
    const internetItem = result.find(r => r.id === internetRow.id)!;

    // Fila TV: recibe los 2 tvEvents con operador real
    expect(tvItem.events).toHaveLength(2);
    expect(tvItem.events[0]!.eventType).toBe('activated');
    expect(tvItem.events[0]!.actorName).toBe('mlopez');
    expect(tvItem.events[1]!.eventType).toBe('deactivated');
    expect(tvItem.events[1]!.actorName).toBe('jperez');

    // Fila no-TV (Internet con notes CIC): NO recibe tvEvents -- sintesis legacy
    expect(internetItem.events).toHaveLength(1);
    expect(internetItem.events[0]!.eventType).toBe('activated');
    expect(internetItem.events[0]!.actorName).toBe(''); // legacy synthesis, no actor
    expect(internetItem.events[0]!.cic).toBeNull();    // sin CIC de tvEvents
  });
});
