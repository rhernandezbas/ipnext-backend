/**
 * InMemoryContractRepository — getNetworkAssignments / updateNetworkAssignment.
 * Shared by AutoAssignContractNetwork (auto) and SetContractNetworkAssignment (manual picker).
 *
 * - getNetworkAssignments: proyección {id, networkSiteId, accessPointId}; ids inexistentes
 *   omitidos del resultado (nunca un error, nunca una fila con valores basura).
 * - updateNetworkAssignment: escribe/limpia SOLO esos 2 campos; devuelve null si el contrato
 *   no existe; NO toca ningún otro campo del contrato.
 */
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';

describe('InMemoryContractRepository — network assignment', () => {
  it('getNetworkAssignments — defaults to (null, null) for a freshly seeded contract', async () => {
    const repo = new InMemoryContractRepository();
    const c1 = repo.seed({ clientName: 'Cliente 1', plan: 'Plan A' });

    const result = await repo.getNetworkAssignments([c1.id]);

    expect(result).toEqual([{ id: c1.id, networkSiteId: null, accessPointId: null }]);
  });

  it('getNetworkAssignments — omits ids that do not exist', async () => {
    const repo = new InMemoryContractRepository();
    const c1 = repo.seed({ clientName: 'Cliente 1', plan: 'Plan A' });

    const result = await repo.getNetworkAssignments([c1.id, 'does-not-exist']);

    expect(result).toEqual([{ id: c1.id, networkSiteId: null, accessPointId: null }]);
  });

  it('getNetworkAssignments — projects seeded networkSiteId/accessPointId', async () => {
    const repo = new InMemoryContractRepository();
    const c1 = repo.seed({ clientName: 'Cliente 1', plan: 'Plan A', networkSiteId: 'ns-1', accessPointId: 'ap-1' });

    const result = await repo.getNetworkAssignments([c1.id]);

    expect(result).toEqual([{ id: c1.id, networkSiteId: 'ns-1', accessPointId: 'ap-1' }]);
  });

  it('updateNetworkAssignment — writes both fields and returns the DTO', async () => {
    const repo = new InMemoryContractRepository();
    const c1 = repo.seed({ clientName: 'Cliente 1', plan: 'Plan A' });

    const result = await repo.updateNetworkAssignment(c1.id, { networkSiteId: 'ns-1', accessPointId: 'ap-1' });

    expect(result).toEqual({ id: c1.id, networkSiteId: 'ns-1', accessPointId: 'ap-1' });
    const projected = await repo.getNetworkAssignments([c1.id]);
    expect(projected[0]).toEqual({ id: c1.id, networkSiteId: 'ns-1', accessPointId: 'ap-1' });
  });

  it('updateNetworkAssignment — null clears both fields', async () => {
    const repo = new InMemoryContractRepository();
    const c1 = repo.seed({ clientName: 'Cliente 1', plan: 'Plan A', networkSiteId: 'ns-1', accessPointId: 'ap-1' });

    const result = await repo.updateNetworkAssignment(c1.id, { networkSiteId: null, accessPointId: null });

    expect(result).toEqual({ id: c1.id, networkSiteId: null, accessPointId: null });
  });

  it('updateNetworkAssignment — returns null when the contract does not exist', async () => {
    const repo = new InMemoryContractRepository();

    const result = await repo.updateNetworkAssignment('does-not-exist', { networkSiteId: 'ns-1', accessPointId: 'ap-1' });

    expect(result).toBeNull();
  });

  it('updateNetworkAssignment — does NOT touch any other field (name stays intact)', async () => {
    const repo = new InMemoryContractRepository();
    const c1 = repo.seed({ clientName: 'Cliente 1', plan: 'Plan A' });
    await repo.updateName(c1.id, 'Nombre manual');

    await repo.updateNetworkAssignment(c1.id, { networkSiteId: 'ns-1', accessPointId: 'ap-1' });

    expect(repo.names[c1.id]).toBe('Nombre manual');
  });
});
