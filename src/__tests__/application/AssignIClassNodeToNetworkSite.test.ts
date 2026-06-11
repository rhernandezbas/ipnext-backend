/**
 * TDD — AssignIClassNodeToNetworkSite use case (REQ-NCAT-3).
 * Covers: happy path (sets iclassNodeCode + city = node.code), null clears only
 * iclassNodeCode (city intact), node not-found / inactive / non-selectable → errors,
 * site not-found → null (route maps to 404).
 */
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { InMemoryIClassNodeRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassNodeRepository';
import { AssignIClassNodeToNetworkSite } from '../../application/use-cases/AssignIClassNodeToNetworkSite';
import { IClassNodeNotFoundError, IClassNodeNotAssignableError } from '../../domain/errors/iclass';
import { NetworkSite } from '../../domain/entities/networkSite';

function baseSite(overrides: Partial<NetworkSite> = {}): NetworkSite {
  return {
    id: 'site-1',
    name: 'Nodo',
    address: 'addr',
    city: 'Lujan',
    coordinates: null,
    type: 'nodo',
    status: 'active',
    deviceCount: 0,
    clientCount: 0,
    uplink: '',
    parentSiteId: null,
    description: '',
    iclassNodeCode: 'Lujan',
    uispSiteId: null,
    ...overrides,
  };
}

async function setup() {
  const sites = new InMemoryNetworkSiteRepository();
  sites.seedSites([baseSite()]);
  const nodes = new InMemoryIClassNodeRepository();

  // active + selectable node "Mercedes"
  await nodes.upsertByNodeId({ nodeId: 1, code: 'Mercedes', description: 'Mercedes', selectable: true });
  // grouping node "Main" (selectable=false)
  await nodes.upsertByNodeId({ nodeId: 2, code: 'Main', description: 'Main', selectable: false });
  // inactive node "Vieja"
  await nodes.upsertByNodeId({ nodeId: 3, code: 'Vieja', description: 'Vieja', selectable: true });
  await nodes.markInactiveExcept([1, 2]); // deactivate node 3

  const all = await nodes.list();
  const mercedes = all.find(n => n.code === 'Mercedes')!;
  const main = all.find(n => n.code === 'Main')!;
  const vieja = all.find(n => n.code === 'Vieja')!;

  const useCase = new AssignIClassNodeToNetworkSite(sites, nodes);
  return { sites, nodes, useCase, mercedes, main, vieja };
}

describe('AssignIClassNodeToNetworkSite', () => {
  it('valid active+selectable node → sets iclassNodeCode AND city to node.code', async () => {
    const { useCase, mercedes } = await setup();
    const updated = await useCase.execute('site-1', mercedes.id);
    expect(updated).not.toBeNull();
    expect(updated!.iclassNodeCode).toBe('Mercedes');
    expect(updated!.city).toBe('Mercedes');
  });

  it('null → clears only iclassNodeCode, city stays intact', async () => {
    const { useCase } = await setup();
    const updated = await useCase.execute('site-1', null);
    expect(updated).not.toBeNull();
    expect(updated!.iclassNodeCode).toBeNull();
    expect(updated!.city).toBe('Lujan');
  });

  it('unknown node id → IClassNodeNotFoundError, site untouched', async () => {
    const { useCase, sites } = await setup();
    await expect(useCase.execute('site-1', 'no-such-uuid')).rejects.toBeInstanceOf(
      IClassNodeNotFoundError,
    );
    const site = await sites.findById('site-1');
    expect(site!.iclassNodeCode).toBe('Lujan');
  });

  it('non-selectable (grouping) node → IClassNodeNotAssignableError, site untouched', async () => {
    const { useCase, main, sites } = await setup();
    await expect(useCase.execute('site-1', main.id)).rejects.toBeInstanceOf(
      IClassNodeNotAssignableError,
    );
    const site = await sites.findById('site-1');
    expect(site!.iclassNodeCode).toBe('Lujan');
  });

  it('inactive node → IClassNodeNotAssignableError', async () => {
    const { useCase, vieja } = await setup();
    await expect(useCase.execute('site-1', vieja.id)).rejects.toBeInstanceOf(
      IClassNodeNotAssignableError,
    );
  });

  it('unknown site → returns null (route maps to 404)', async () => {
    const { useCase, mercedes } = await setup();
    const result = await useCase.execute('no-site', mercedes.id);
    expect(result).toBeNull();
  });

  it('null on unknown site → returns null', async () => {
    const { useCase } = await setup();
    const result = await useCase.execute('no-site', null);
    expect(result).toBeNull();
  });
});
