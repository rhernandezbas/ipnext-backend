import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { MaterialCatalogService } from '@application/services/MaterialCatalogService';

describe('MaterialCatalogService', () => {
  it('isValid returns true for a known active material, false for unknown', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    await repo.create({ name: 'CABLE_UTP', sortOrder: 0, active: true });

    const service = new MaterialCatalogService(repo);
    expect(await service.isValid('CABLE_UTP')).toBe(true);
    expect(await service.isValid('ROSETA')).toBe(false);
  });

  it('isValid is case-insensitive', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    await repo.create({ name: 'CABLE_UTP', sortOrder: 0, active: true });

    const service = new MaterialCatalogService(repo);
    expect(await service.isValid('cable_utp')).toBe(true);
  });

  it('isValid returns false for null/undefined', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const service = new MaterialCatalogService(repo);
    expect(await service.isValid(null)).toBe(false);
    expect(await service.isValid(undefined)).toBe(false);
    expect(await service.isValid('')).toBe(false);
  });

  it('invalidate causes the next ensure() to re-fetch', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    await repo.create({ name: 'CABLE_UTP', sortOrder: 0, active: true });

    const service = new MaterialCatalogService(repo);
    await service.ensure(); // warm cache

    await repo.create({ name: 'ROSETA', sortOrder: 5, active: true });

    // Before invalidate, ROSETA is NOT in cache
    expect(await service.isValid('ROSETA')).toBe(false);

    // After invalidate, ROSETA IS found
    service.invalidate();
    expect(await service.isValid('ROSETA')).toBe(true);
  });

  it('ensure() only calls repo once when cache is warm', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    await repo.create({ name: 'CABLE_UTP', sortOrder: 0, active: true });

    let callCount = 0;
    const originalListActiveNames = repo.listActiveNames.bind(repo);
    repo.listActiveNames = async () => { callCount++; return originalListActiveNames(); };

    const service = new MaterialCatalogService(repo);

    await service.ensure();
    await service.ensure();

    expect(callCount).toBe(1);
  });
});
