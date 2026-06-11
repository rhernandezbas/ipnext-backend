import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { UpdateDeviceType } from '@application/use-cases/UpdateDeviceType';
import {
  DeviceTypeNotFoundError,
  DeviceTypeNameConflictError,
  DeviceTypeNonRenameableError,
} from '@domain/errors/inventory';

describe('UpdateDeviceType', () => {
  it('applies a partial patch', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const item = await repo.create({ name: 'ONU', sortOrder: 0 });

    const update = new UpdateDeviceType(repo);
    const result = await update.execute(item.id, { label: 'Óptica', sortOrder: 5 });

    expect(result.label).toBe('Óptica');
    expect(result.sortOrder).toBe(5);
    expect(result.name).toBe('ONU'); // unchanged
  });

  it('throws DeviceTypeNotFoundError for unknown id', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const update = new UpdateDeviceType(repo);
    await expect(update.execute('nonexistent', { label: 'x' })).rejects.toBeInstanceOf(DeviceTypeNotFoundError);
  });

  it('throws DeviceTypeNameConflictError on rename collision (case-insensitive)', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    await repo.create({ name: 'ONU', sortOrder: 0 });
    const router = await repo.create({ name: 'ROUTER', sortOrder: 1 });

    const update = new UpdateDeviceType(repo);
    await expect(update.execute(router.id, { name: 'onu' })).rejects.toBeInstanceOf(DeviceTypeNameConflictError);
  });

  it('normalizes renamed name to UPPERCASE', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const item = await repo.create({ name: 'ONU', sortOrder: 0 });

    const update = new UpdateDeviceType(repo);
    const result = await update.execute(item.id, { name: 'optical' });

    expect(result.name).toBe('OPTICAL');
  });

  it('deactivating a non-OTROS entry succeeds', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const item = await repo.create({ name: 'ROUTER', sortOrder: 1, active: true });

    const update = new UpdateDeviceType(repo);
    const result = await update.execute(item.id, { active: false });

    expect(result.active).toBe(false);
  });

  // #43 DEBT — mirror the ServiceCatalog fix. OTROS is the protected catch-all;
  // renaming it would bypass the non-deletable guard (rename OTROS → "X", then
  // create a fresh deletable "OTROS"). The protected name is frozen.
  it('blocks renaming OTROS to a different name (422 NON_RENAMEABLE) (#43 debt)', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const otros = await repo.create({ name: 'OTROS', sortOrder: 9 });

    const update = new UpdateDeviceType(repo);
    await expect(update.execute(otros.id, { name: 'MISC' })).rejects.toBeInstanceOf(
      DeviceTypeNonRenameableError,
    );
  });

  it('blocks renaming OTROS case-insensitively (otros lowercase rename target) (#43 debt)', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const otros = await repo.create({ name: 'OTROS', sortOrder: 9 });

    const update = new UpdateDeviceType(repo);
    await expect(update.execute(otros.id, { name: 'misc' })).rejects.toBeInstanceOf(
      DeviceTypeNonRenameableError,
    );
  });

  it('allows editing OTROS label/active/sortOrder (only the name is frozen) (#43 debt)', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const otros = await repo.create({ name: 'OTROS', sortOrder: 9, active: true });

    const update = new UpdateDeviceType(repo);
    const result = await update.execute(otros.id, { label: 'Otros equipos', sortOrder: 3, active: false });

    expect(result.label).toBe('Otros equipos');
    expect(result.sortOrder).toBe(3);
    expect(result.active).toBe(false);
    expect(result.name).toBe('OTROS');
  });

  it('allows a no-op name on OTROS (same name, case-insensitive — not an actual rename) (#43 debt)', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const otros = await repo.create({ name: 'OTROS', sortOrder: 9 });

    const update = new UpdateDeviceType(repo);
    const result = await update.execute(otros.id, { name: 'otros' });
    expect(result.name).toBe('OTROS');
  });

  it('renaming a non-OTROS entry TO "OTROS" hits the existing name-conflict guard (#43 debt)', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    await repo.create({ name: 'OTROS', sortOrder: 9 });
    const router = await repo.create({ name: 'ROUTER', sortOrder: 1 });

    const update = new UpdateDeviceType(repo);
    await expect(update.execute(router.id, { name: 'otros' })).rejects.toBeInstanceOf(
      DeviceTypeNameConflictError,
    );
  });
});
