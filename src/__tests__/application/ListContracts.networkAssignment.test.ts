/**
 * contract-network-read — ListContracts.execute() must expose the CURRENT
 * node/AP assignment on the ContractSummaryDto so the FE picker (Fase B) can
 * render what is already assigned instead of flying blind.
 *
 * Contract acordado con el FE — 4 campos nullable, nombres EXACTOS:
 *   networkSiteId, networkSiteName, accessPointId, accessPointName
 *
 * Root cause: Contract.networkSiteId/accessPointId are written by the
 * auto-assign (flag DARK) and by the manual picker's PATCH, but ListContracts
 * never read/mapped them — only the PATCH echoed them back.
 */
import { ListContracts } from '@application/use-cases/ListContracts';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';

describe('ListContracts — network assignment (networkSiteId/networkSiteName/accessPointId/accessPointName)', () => {
  it('exposes null for all 4 fields when the contract has no assignment', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({ clientName: 'Juan', plan: '300MB' });

    const useCase = new ListContracts(repo);
    const result = await useCase.execute({ page: 1, limit: 25 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].networkSiteId).toBeNull();
    expect(result.data[0].networkSiteName).toBeNull();
    expect(result.data[0].accessPointId).toBeNull();
    expect(result.data[0].accessPointName).toBeNull();
  });

  it('exposes the assigned node/AP id + name when the contract has an assignment', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({
      clientName: 'María',
      plan: '50MB',
      networkSiteId: 'ns-1',
      networkSiteName: 'Nodo Centro',
      accessPointId: 'ap-1',
      accessPointName: 'AP Torre Norte',
    });

    const useCase = new ListContracts(repo);
    const result = await useCase.execute({ page: 1, limit: 25 });

    expect(result.data[0].networkSiteId).toBe('ns-1');
    expect(result.data[0].networkSiteName).toBe('Nodo Centro');
    expect(result.data[0].accessPointId).toBe('ap-1');
    expect(result.data[0].accessPointName).toBe('AP Torre Norte');
  });

  it('supports a node-only assignment (site set, AP still null) — triangulation', async () => {
    const repo = new InMemoryContractRepository();
    repo.seed({
      clientName: 'Pedro',
      plan: '100MB',
      networkSiteId: 'ns-2',
      networkSiteName: 'Nodo Sur',
    });

    const useCase = new ListContracts(repo);
    const result = await useCase.execute({ page: 1, limit: 25 });

    expect(result.data[0].networkSiteId).toBe('ns-2');
    expect(result.data[0].networkSiteName).toBe('Nodo Sur');
    expect(result.data[0].accessPointId).toBeNull();
    expect(result.data[0].accessPointName).toBeNull();
  });
});
