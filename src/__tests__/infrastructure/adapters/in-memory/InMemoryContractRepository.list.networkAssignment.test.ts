/**
 * InMemoryContractRepository.list() — contract-network-read (read side).
 *
 * Separate file from InMemoryContractRepository.networkAssignment.test.ts on purpose:
 * that file covers the PATCH-supporting methods (getNetworkAssignments/
 * updateNetworkAssignment), which this change does NOT touch. This file exercises the
 * READ path (list()) directly, at the repo layer (below ListContracts), pinning that
 * seed() → list() round-trips all 4 fields: networkSiteId, networkSiteName,
 * accessPointId, accessPointName.
 */
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';

describe('InMemoryContractRepository.list() — network assignment fields', () => {
  it('defaults all 4 fields to null for a contract seeded without an assignment', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({ clientName: 'Cliente 1', plan: 'Plan A' });

    const result = await repo.list({ page: 1, limit: 25 });

    expect(result.data[0]?.networkSiteId).toBeNull();
    expect(result.data[0]?.networkSiteName).toBeNull();
    expect(result.data[0]?.accessPointId).toBeNull();
    expect(result.data[0]?.accessPointName).toBeNull();
  });

  it('round-trips a seeded assignment through list() — triangulation', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({
      clientName: 'Cliente 2',
      plan: 'Plan B',
      networkSiteId: 'ns-9',
      networkSiteName: 'Nodo Oeste',
      accessPointId: 'ap-9',
      accessPointName: 'AP Loma',
    });

    const result = await repo.list({ page: 1, limit: 25 });

    expect(result.data[0]).toMatchObject({
      networkSiteId: 'ns-9',
      networkSiteName: 'Nodo Oeste',
      accessPointId: 'ap-9',
      accessPointName: 'AP Loma',
    });
  });
});
