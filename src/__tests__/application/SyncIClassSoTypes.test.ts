/**
 * TDD — SyncIClassSoTypes use case
 * Covers REQ-SYNC-1 scenarios.
 */
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassSoTypeRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassSoTypeRepository';
import { SyncIClassSoTypes } from '../../application/use-cases/SyncIClassSoTypes';
import { IClassUnavailableError } from '../../domain/errors/iclass';

function setup() {
  const iclass = new InMemoryIClassClient();
  const repo = new InMemoryIClassSoTypeRepository();
  const useCase = new SyncIClassSoTypes(iclass, repo);
  return { iclass, repo, useCase };
}

describe('SyncIClassSoTypes', () => {
  it('fresh DB + 3 types → all 3 created, deactivated=0', async () => {
    const { iclass, repo, useCase } = setup();
    iclass.serviceOrderTypes = [
      { code: 'INSTALL', description: 'Installation' },
      { code: 'REPAIR', description: 'Repair' },
      { code: 'MAINT', description: 'Maintenance' },
    ];

    const result = await useCase.execute();

    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.reactivated).toBe(0);
    expect(result.deactivated).toBe(0);

    const all = await repo.list();
    expect(all).toHaveLength(3);
    expect(all.every(e => e.active)).toBe(true);
  });

  it('re-sync idempotent → all updated, created=0, deactivated=0', async () => {
    const { iclass, repo, useCase } = setup();
    iclass.serviceOrderTypes = [
      { code: 'INSTALL', description: 'Installation' },
      { code: 'REPAIR', description: 'Repair' },
    ];

    await useCase.execute(); // first run
    const result = await useCase.execute(); // second run

    expect(result.created).toBe(0);
    expect(result.updated).toBe(2);
    expect(result.reactivated).toBe(0);
    expect(result.deactivated).toBe(0);
  });

  it('one code disappears → deactivated=1, entry has active=false', async () => {
    const { iclass, repo, useCase } = setup();
    iclass.serviceOrderTypes = [
      { code: 'INSTALL', description: 'Installation' },
      { code: 'REPAIR', description: 'Repair' },
      { code: 'MAINT', description: 'Maintenance' },
    ];

    await useCase.execute(); // seed 3

    iclass.serviceOrderTypes = [
      { code: 'INSTALL', description: 'Installation' },
      { code: 'REPAIR', description: 'Repair' },
    ];

    const result = await useCase.execute(); // MAINT disappears

    expect(result.deactivated).toBe(1);
    expect(result.synced).toBe(2);

    const inactive = await repo.list({ active: false });
    expect(inactive).toHaveLength(1);
    expect(inactive[0].code).toBe('MAINT');
  });

  it('previously deactivated code reappears → reactivated=1', async () => {
    const { iclass, repo, useCase } = setup();
    iclass.serviceOrderTypes = [
      { code: 'INSTALL', description: 'Installation' },
      { code: 'REPAIR', description: 'Repair' },
    ];
    await useCase.execute();

    // deactivate REPAIR
    iclass.serviceOrderTypes = [{ code: 'INSTALL', description: 'Installation' }];
    await useCase.execute();

    const before = await repo.list({ active: false });
    expect(before.some(e => e.code === 'REPAIR')).toBe(true);

    // REPAIR comes back
    iclass.serviceOrderTypes = [
      { code: 'INSTALL', description: 'Installation' },
      { code: 'REPAIR', description: 'Repair' },
    ];
    const result = await useCase.execute();

    expect(result.reactivated).toBe(1);
    expect(result.deactivated).toBe(0);

    const active = await repo.list({ active: true });
    expect(active.some(e => e.code === 'REPAIR')).toBe(true);
  });

  it('IClass returns empty → all existing entries deactivated', async () => {
    const { iclass, repo, useCase } = setup();
    iclass.serviceOrderTypes = [
      { code: 'INSTALL', description: 'Installation' },
    ];
    await useCase.execute();

    iclass.serviceOrderTypes = [];
    const result = await useCase.execute();

    expect(result.deactivated).toBe(1);
    expect(result.synced).toBe(0);

    const all = await repo.list();
    expect(all.every(e => !e.active)).toBe(true);
  });

  it('IClass fails → propagates IClassUnavailableError', async () => {
    const { iclass, useCase } = setup();
    iclass.failureMode = 'unavailable';

    await expect(useCase.execute()).rejects.toBeInstanceOf(IClassUnavailableError);
  });
});
