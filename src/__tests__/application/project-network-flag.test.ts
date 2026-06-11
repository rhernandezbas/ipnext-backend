/**
 * #40 — InMemory round-trip for Project.isNetworkProject.
 * Mirrors the allowsEquipmentRetirement flag behavior:
 *  - create with no flag → defaults to false
 *  - PATCH-style update with isNetworkProject: true → persisted and returned true
 *  - toggling back to false works
 */
import { InMemoryProjectRepository } from '../../infrastructure/adapters/in-memory/InMemoryProjectRepository';

describe('Project.isNetworkProject — InMemory round-trip (#40)', () => {
  it('newly created project defaults isNetworkProject to false', async () => {
    const repo = new InMemoryProjectRepository();
    const created = await repo.create({ title: 'Proyecto FTTH', visible: true });
    expect(created.isNetworkProject).toBe(false);
  });

  it('update with isNetworkProject: true persists and GET returns true', async () => {
    const repo = new InMemoryProjectRepository();
    const created = await repo.create({ title: 'Red - Fibra', visible: true });

    const updated = await repo.update(created.id, { isNetworkProject: true });
    expect(updated?.isNetworkProject).toBe(true);

    const fetched = await repo.get(created.id);
    expect(fetched?.isNetworkProject).toBe(true);
  });

  it('update with isNetworkProject: false toggles the flag back off', async () => {
    const repo = new InMemoryProjectRepository();
    const created = await repo.create({ title: 'Red - Wireless', visible: true });
    await repo.update(created.id, { isNetworkProject: true });

    const toggledOff = await repo.update(created.id, { isNetworkProject: false });
    expect(toggledOff?.isNetworkProject).toBe(false);
  });

  it('update without isNetworkProject leaves the flag untouched', async () => {
    const repo = new InMemoryProjectRepository();
    const created = await repo.create({ title: 'Mixed', visible: true });
    await repo.update(created.id, { isNetworkProject: true });

    const titleOnly = await repo.update(created.id, { title: 'Renamed' });
    expect(titleOnly?.isNetworkProject).toBe(true);
    expect(titleOnly?.title).toBe('Renamed');
  });
});
