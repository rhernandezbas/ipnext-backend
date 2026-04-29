import { InMemoryIpNetworkRepository } from '../../infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { ListIpNetworks } from '../../application/use-cases/ListIpNetworks';
import { CreateIpNetwork } from '../../application/use-cases/CreateIpNetwork';
import { ListIpPools } from '../../application/use-cases/ListIpPools';
import { CreateIpPool } from '../../application/use-cases/CreateIpPool';
import { ListIpAssignments } from '../../application/use-cases/ListIpAssignments';

function makeRepo() {
  return new InMemoryIpNetworkRepository();
}

describe('ListIpNetworks', () => {
  it('returns 2 seeded networks', async () => {
    const repo = makeRepo();
    const uc = new ListIpNetworks(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(2);
    expect(result[0].network).toBe('192.168.1.0/24');
    expect(result[1].network).toBe('10.0.0.0/16');
  });

  it('IpNetwork totalIps is 254 for /24', async () => {
    const repo = makeRepo();
    const uc = new ListIpNetworks(repo);

    const result = await uc.execute();
    const cidr24 = result.find(n => n.network === '192.168.1.0/24');

    expect(cidr24).toBeDefined();
    expect(cidr24!.totalIps).toBe(254);
  });
});

describe('CreateIpNetwork', () => {
  it('creates a network with correct fields', async () => {
    const repo = makeRepo();
    const uc = new CreateIpNetwork(repo);

    const result = await uc.execute({
      network: '172.16.0.0/24',
      gateway: '172.16.0.1',
      dns1: '8.8.8.8',
      dns2: '8.8.4.4',
      description: 'Test network',
      partnerId: null,
      type: 'static',
      totalIps: 254,
      usedIps: 0,
      freeIps: 254,
    });

    expect(result.id).toBeTruthy();
    expect(result.network).toBe('172.16.0.0/24');
    expect(result.type).toBe('static');
  });
});

describe('ListIpPools', () => {
  it('returns 3 seeded pools', async () => {
    const repo = makeRepo();
    const uc = new ListIpPools(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('residencial-dinamico');
  });
});

describe('CreateIpPool', () => {
  it('creates pool assigned to network', async () => {
    const repo = makeRepo();
    const uc = new CreateIpPool(repo);

    const result = await uc.execute({
      name: 'nuevo-pool',
      networkId: '1',
      rangeStart: '192.168.1.210',
      rangeEnd: '192.168.1.220',
      type: 'static',
      assignedCount: 0,
      totalCount: 11,
      nasId: null,
    });

    expect(result.id).toBeTruthy();
    expect(result.networkId).toBe('1');
    expect(result.name).toBe('nuevo-pool');
  });
});

describe('ListIpAssignments', () => {
  it('returns 5 seeded assignments', async () => {
    const repo = makeRepo();
    const uc = new ListIpAssignments(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(5);
    expect(result.every(a => a.id && a.ip && a.poolId)).toBe(true);
  });
});
