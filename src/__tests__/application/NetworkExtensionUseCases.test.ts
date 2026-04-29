import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { ListNetworkSites } from '../../application/use-cases/ListNetworkSites';
import { CreateNetworkSite } from '../../application/use-cases/CreateNetworkSite';
import { InMemoryCpeRepository } from '../../infrastructure/adapters/in-memory/InMemoryCpeRepository';
import { ListCpeDevices } from '../../application/use-cases/ListCpeDevices';
import { GetCpeDevice } from '../../application/use-cases/GetCpeDevice';
import { AssignCpeToClient } from '../../application/use-cases/AssignCpeToClient';
import { InMemoryTr069Repository } from '../../infrastructure/adapters/in-memory/InMemoryTr069Repository';
import { ListTr069Profiles } from '../../application/use-cases/ListTr069Profiles';
import { ListTr069Devices } from '../../application/use-cases/ListTr069Devices';
import { InMemoryIpNetworkRepository } from '../../infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { ListIpv6Networks } from '../../application/use-cases/ListIpv6Networks';
import { CreateIpv6Network } from '../../application/use-cases/CreateIpv6Network';
import { InMemoryHardwareRepository } from '../../infrastructure/adapters/in-memory/InMemoryHardwareRepository';
import { ListHardwareAssets } from '../../application/use-cases/ListHardwareAssets';
import { CreateHardwareAsset } from '../../application/use-cases/CreateHardwareAsset';

// Module 1: Network Sites
describe('ListNetworkSites', () => {
  it('returns 5 seeded network sites', async () => {
    const repo = new InMemoryNetworkSiteRepository();
    const uc = new ListNetworkSites(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(5);
  });

  it('types include pop and tower', async () => {
    const repo = new InMemoryNetworkSiteRepository();
    const uc = new ListNetworkSites(repo);

    const result = await uc.execute();
    const types = result.map(s => s.type);

    expect(types).toContain('pop');
    expect(types).toContain('tower');
  });
});

describe('CreateNetworkSite', () => {
  it('creates a new network site', async () => {
    const repo = new InMemoryNetworkSiteRepository();
    const uc = new CreateNetworkSite(repo);

    const result = await uc.execute({
      name: 'Test Site',
      address: 'Test 123',
      city: 'Test City',
      coordinates: null,
      type: 'nodo',
      status: 'active',
      deviceCount: 0,
      clientCount: 0,
      uplink: '1 Gbps',
      parentSiteId: null,
      description: 'Test',
    });

    expect(result.id).toBeDefined();
    expect(result.name).toBe('Test Site');
    expect(result.type).toBe('nodo');
  });
});

// Module 2: CPE
describe('ListCpeDevices', () => {
  it('returns 10 seeded CPE devices', async () => {
    const repo = new InMemoryCpeRepository();
    const uc = new ListCpeDevices(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(10);
  });
});

describe('GetCpeDevice', () => {
  it('returns CPE device by id', async () => {
    const repo = new InMemoryCpeRepository();
    const uc = new GetCpeDevice(repo);

    const result = await uc.execute('1');

    expect(result).not.toBeNull();
    expect(result!.serialNumber).toBe('SN-ROT-001');
  });
});

describe('AssignCpeToClient', () => {
  it('updates clientId of CPE device', async () => {
    const repo = new InMemoryCpeRepository();
    const uc = new AssignCpeToClient(repo);

    const result = await uc.execute('7', 'client-99', 'New Client');

    expect(result).not.toBeNull();
    expect(result!.clientId).toBe('client-99');
    expect(result!.clientName).toBe('New Client');
  });
});

// Module 3: TR-069
describe('ListTr069Profiles', () => {
  it('returns 3 seeded TR-069 profiles', async () => {
    const repo = new InMemoryTr069Repository();
    const uc = new ListTr069Profiles(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(3);
  });
});

describe('ListTr069Devices', () => {
  it('returns 8 seeded TR-069 devices', async () => {
    const repo = new InMemoryTr069Repository();
    const uc = new ListTr069Devices(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(8);
  });
});

// Module 4: IPv6 Networks
describe('ListIpv6Networks', () => {
  it('returns 2 seeded IPv6 networks', async () => {
    const repo = new InMemoryIpNetworkRepository();
    const uc = new ListIpv6Networks(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(2);
  });
});

describe('CreateIpv6Network', () => {
  it('creates a new IPv6 network and returns 201 shape', async () => {
    const repo = new InMemoryIpNetworkRepository();
    const uc = new CreateIpv6Network(repo);

    const result = await uc.execute({
      network: '2001:db8:1::/48',
      description: 'Test IPv6',
      delegationPrefix: 64,
      type: 'slaac',
      usedPrefixes: 0,
      totalPrefixes: 65536,
      status: 'active',
    });

    expect(result.id).toBeDefined();
    expect(result.network).toBe('2001:db8:1::/48');
  });
});

// Module 5: Hardware
describe('ListHardwareAssets', () => {
  it('returns 8 seeded hardware assets', async () => {
    const repo = new InMemoryHardwareRepository();
    const uc = new ListHardwareAssets(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(8);
  });

  it('assets have warrantyExpiry field', async () => {
    const repo = new InMemoryHardwareRepository();
    const uc = new ListHardwareAssets(repo);

    const result = await uc.execute();

    result.forEach(asset => {
      expect('warrantyExpiry' in asset).toBe(true);
    });
  });
});

describe('CreateHardwareAsset', () => {
  it('creates a new hardware asset', async () => {
    const repo = new InMemoryHardwareRepository();
    const uc = new CreateHardwareAsset(repo);

    const result = await uc.execute({
      name: 'Test Switch',
      category: 'switch',
      serialNumber: 'TEST-001',
      model: 'Test Model',
      manufacturer: 'Test Mfg',
      purchaseDate: '2026-01-01',
      purchasePrice: 50000,
      warrantyExpiry: '2029-01-01',
      location: 'Rack A',
      networkSiteId: null,
      status: 'spare',
      assignedTo: null,
      notes: '',
    });

    expect(result.id).toBeDefined();
    expect(result.name).toBe('Test Switch');
    expect(result.category).toBe('switch');
  });
});
