/**
 * EnsureInternetContractService (#1) — TDD: escrito ANTES de la implementación.
 *
 * Escenarios:
 *   - active=true, no existe → crea la línea INTERNET
 *   - active=true, existe inactive → reactiva
 *   - active=true, existe active → no-op
 *   - active=false, existe active → inactiva
 *   - active=false, no existe → no-op
 *   - catálogo INTERNET no existe → warn + no lanza
 *   - catálogo INTERNET existe pero inactive → warn + no lanza
 *   - best-effort: csRepo.add lanza → no rompe el caller (sin throw)
 */
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

async function seedInternetCatalog(catalogRepo: InMemoryServiceCatalogRepository, active = true) {
  return catalogRepo.create({ name: 'INTERNET', label: 'Internet', active, sortOrder: 1 });
}

describe('EnsureInternetContractService', () => {
  let csRepo: InMemoryContractServiceRepository;
  let catalogRepo: InMemoryServiceCatalogRepository;
  let uc: EnsureInternetContractService;

  beforeEach(() => {
    csRepo = new InMemoryContractServiceRepository();
    catalogRepo = new InMemoryServiceCatalogRepository();
    uc = new EnsureInternetContractService(csRepo, catalogRepo);
  });

  // ── active=true ────────────────────────────────────────────────────────────

  it('active=true + sin línea → crea la línea INTERNET (status active)', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };

    await uc.execute('C1', true);

    const cs = await csRepo.getByPair('C1', catalog.id);
    expect(cs).not.toBeNull();
    expect(cs!.status).toBe('active');
  });

  it('active=true + línea inactive → reactiva (status → active)', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    const created = await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });
    await csRepo.update(created.id, { status: 'inactive' });

    await uc.execute('C1', true);

    const cs = await csRepo.getByPair('C1', catalog.id);
    expect(cs!.status).toBe('active');
  });

  it('active=true + línea ya active → no-op (no crea duplicado)', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });

    await uc.execute('C1', true); // no debe tirar ContractServiceDuplicateError

    const rows = await csRepo.listByContract('C1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');
  });

  // ── active=false ───────────────────────────────────────────────────────────

  it('active=false + línea active → inactiva (status → inactive)', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });

    await uc.execute('C1', false);

    const cs = await csRepo.getByPair('C1', catalog.id);
    expect(cs!.status).toBe('inactive');
  });

  it('active=false + sin línea → no-op (no crea ni lanza)', async () => {
    await seedInternetCatalog(catalogRepo);
    await uc.execute('C1', false); // no debe lanzar
    const rows = await csRepo.listByContract('C1');
    expect(rows).toHaveLength(0);
  });

  it('active=false + línea already inactive → no-op (no doble update)', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    const created = await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });
    await csRepo.update(created.id, { status: 'inactive' });

    await uc.execute('C1', false); // no debe tirar

    const cs = await csRepo.getByPair('C1', catalog.id);
    expect(cs!.status).toBe('inactive');
  });

  // ── best-effort / catálogo faltante ────────────────────────────────────────

  it('catálogo INTERNET no existe → no lanza (best-effort)', async () => {
    // catalogRepo vacío — returns false (no transition) and does not throw.
    await expect(uc.execute('C1', true)).resolves.toBe(false);
  });

  it('catálogo INTERNET existe pero inactive → no lanza (best-effort)', async () => {
    await seedInternetCatalog(catalogRepo, false); // active=false
    // Returns false (no transition) and does not throw.
    await expect(uc.execute('C1', true)).resolves.toBe(false);
  });
});
