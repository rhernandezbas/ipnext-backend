import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { GetLowStockAlerts } from '@application/use-cases/GetLowStockAlerts';

/**
 * SCEN-ALT-1: material below threshold → appears with correct deficit
 * SCEN-ALT-2: material at or above threshold → excluded
 * SCEN-ALT-3: minStock = 0 → never alerts
 * Multi-location SUM: stock across multiple locations is summed
 */
describe('GetLowStockAlerts', () => {
  function makeRepos() {
    const materialCatalog = new InMemoryMaterialCatalogRepository();
    const stockRepo = new InMemoryMaterialStockRepository();
    materialCatalog.stockRepo = stockRepo;
    return { materialCatalog, stockRepo };
  }

  it('SCEN-ALT-3: minStock=0 never generates alert even with zero stock', async () => {
    const { materialCatalog } = makeRepos();
    await materialCatalog.create({ name: 'CABLE_UTP', sortOrder: 0, minStock: 0 });

    const uc = new GetLowStockAlerts(materialCatalog);
    const result = await uc.execute();

    expect(result).toHaveLength(0);
  });

  it('SCEN-ALT-1: material below threshold returns alert with correct deficit', async () => {
    const { materialCatalog, stockRepo } = makeRepos();
    const mat = await materialCatalog.create({ name: 'CABLE_UTP', sortOrder: 0, minStock: 10 });

    // Only 3 units in stock
    await stockRepo.upsert({ id: 'ms1', materialCatalogId: mat.id, locationId: 'loc-depot', qty: 3 });

    const uc = new GetLowStockAlerts(materialCatalog);
    const result = await uc.execute();

    expect(result).toHaveLength(1);
    expect(result[0].materialCatalogId).toBe(mat.id);
    expect(result[0].totalQty).toBe(3);
    expect(result[0].minStock).toBe(10);
    expect(result[0].deficit).toBe(7);
  });

  it('SCEN-ALT-2: material at or above threshold is excluded', async () => {
    const { materialCatalog, stockRepo } = makeRepos();

    // M1: exactly at threshold
    const m1 = await materialCatalog.create({ name: 'CABLE_UTP', sortOrder: 0, minStock: 10 });
    await stockRepo.upsert({ id: 'ms1', materialCatalogId: m1.id, locationId: 'loc-depot', qty: 10 });

    // M2: above threshold
    const m2 = await materialCatalog.create({ name: 'CABLE_FIBRA', sortOrder: 1, minStock: 5 });
    await stockRepo.upsert({ id: 'ms2', materialCatalogId: m2.id, locationId: 'loc-depot', qty: 8 });

    const uc = new GetLowStockAlerts(materialCatalog);
    const result = await uc.execute();

    expect(result).toHaveLength(0);
  });

  it('multi-location: SUM(qty) across all locations compared to minStock', async () => {
    const { materialCatalog, stockRepo } = makeRepos();
    const mat = await materialCatalog.create({ name: 'CABLE_UTP', sortOrder: 0, minStock: 10 });

    // Stock in 2 locations: 4 + 3 = 7, still below minStock=10
    await stockRepo.upsert({ id: 'ms1', materialCatalogId: mat.id, locationId: 'loc-depot', qty: 4 });
    await stockRepo.upsert({ id: 'ms2', materialCatalogId: mat.id, locationId: 'loc-client', qty: 3 });

    const uc = new GetLowStockAlerts(materialCatalog);
    const result = await uc.execute();

    expect(result).toHaveLength(1);
    expect(result[0].totalQty).toBe(7);
    expect(result[0].deficit).toBe(3);
  });

  it('multi-location: SUM meets threshold → no alert', async () => {
    const { materialCatalog, stockRepo } = makeRepos();
    const mat = await materialCatalog.create({ name: 'CABLE_UTP', sortOrder: 0, minStock: 10 });

    // Stock in 2 locations: 6 + 5 = 11, above minStock=10
    await stockRepo.upsert({ id: 'ms1', materialCatalogId: mat.id, locationId: 'loc-depot', qty: 6 });
    await stockRepo.upsert({ id: 'ms2', materialCatalogId: mat.id, locationId: 'loc-client', qty: 5 });

    const uc = new GetLowStockAlerts(materialCatalog);
    const result = await uc.execute();

    expect(result).toHaveLength(0);
  });

  it('name and unit are included in the alert', async () => {
    const { materialCatalog, stockRepo } = makeRepos();
    const mat = await materialCatalog.create({ name: 'CABLE_UTP', label: 'Cable UTP', unit: 'm', sortOrder: 0, minStock: 10 });
    await stockRepo.upsert({ id: 'ms1', materialCatalogId: mat.id, locationId: 'loc-depot', qty: 2 });

    const uc = new GetLowStockAlerts(materialCatalog);
    const result = await uc.execute();

    expect(result[0].name).toBe('CABLE_UTP');
    expect(result[0].label).toBe('Cable UTP');
    expect(result[0].unit).toBe('m');
  });
});
