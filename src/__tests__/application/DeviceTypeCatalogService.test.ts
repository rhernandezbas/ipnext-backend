import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { DeviceTypeCatalogService } from '@application/services/DeviceTypeCatalogService';

describe('DeviceTypeCatalogService', () => {
  it('isValid returns true for a known active type, false for unknown', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    await repo.create({ name: 'ONU', sortOrder: 0, active: true });

    const service = new DeviceTypeCatalogService(repo);
    expect(await service.isValid('ONU')).toBe(true);
    expect(await service.isValid('SWITCH')).toBe(false);
  });

  it('isValid is case-insensitive', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    await repo.create({ name: 'ONU', sortOrder: 0, active: true });

    const service = new DeviceTypeCatalogService(repo);
    expect(await service.isValid('onu')).toBe(true);
  });

  it('isValid returns false for null/undefined', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const service = new DeviceTypeCatalogService(repo);
    expect(await service.isValid(null)).toBe(false);
    expect(await service.isValid(undefined)).toBe(false);
    expect(await service.isValid('')).toBe(false);
  });

  it('invalidate causes the next ensure() to re-fetch', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    await repo.create({ name: 'ONU', sortOrder: 0, active: true });

    const service = new DeviceTypeCatalogService(repo);
    await service.ensure(); // warm cache

    // Add a new type to the repo after cache is warm
    await repo.create({ name: 'SWITCH', sortOrder: 5, active: true });

    // Before invalidate, SWITCH is NOT in cache
    expect(await service.isValid('SWITCH')).toBe(false);

    // After invalidate, SWITCH IS found
    service.invalidate();
    expect(await service.isValid('SWITCH')).toBe(true);
  });

  it('ensure() only calls repo once when cache is warm (single-fetch guarantee)', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    await repo.create({ name: 'ONU', sortOrder: 0, active: true });

    let callCount = 0;
    const originalListActiveNames = repo.listActiveNames.bind(repo);
    repo.listActiveNames = async () => { callCount++; return originalListActiveNames(); };

    const service = new DeviceTypeCatalogService(repo);

    await service.ensure();
    await service.ensure(); // second call — should hit cache

    expect(callCount).toBe(1);
  });
});
