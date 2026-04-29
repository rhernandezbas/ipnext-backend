import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { ListNetworkSites } from '../../application/use-cases/ListNetworkSites';
import { GetNetworkSite } from '../../application/use-cases/GetNetworkSite';
import { CreateNetworkSite } from '../../application/use-cases/CreateNetworkSite';
import { UpdateNetworkSite } from '../../application/use-cases/UpdateNetworkSite';
import { DeleteNetworkSite } from '../../application/use-cases/DeleteNetworkSite';
import { createNetworkSiteRouter } from '../../infrastructure/http/routes/networkSite.routes';
import { InMemoryCpeRepository } from '../../infrastructure/adapters/in-memory/InMemoryCpeRepository';
import { ListCpeDevices } from '../../application/use-cases/ListCpeDevices';
import { GetCpeDevice } from '../../application/use-cases/GetCpeDevice';
import { CreateCpeDevice } from '../../application/use-cases/CreateCpeDevice';
import { UpdateCpeDevice } from '../../application/use-cases/UpdateCpeDevice';
import { DeleteCpeDevice } from '../../application/use-cases/DeleteCpeDevice';
import { AssignCpeToClient } from '../../application/use-cases/AssignCpeToClient';
import { createCpeRouter } from '../../infrastructure/http/routes/cpe.routes';
import { InMemoryTr069Repository } from '../../infrastructure/adapters/in-memory/InMemoryTr069Repository';
import { ListTr069Profiles } from '../../application/use-cases/ListTr069Profiles';
import { CreateTr069Profile } from '../../application/use-cases/CreateTr069Profile';
import { ListTr069Devices } from '../../application/use-cases/ListTr069Devices';
import { ProvisionDevice } from '../../application/use-cases/ProvisionDevice';
import { createTr069Router } from '../../infrastructure/http/routes/tr069.routes';
import { InMemoryIpNetworkRepository } from '../../infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { ListIpNetworks } from '../../application/use-cases/ListIpNetworks';
import { CreateIpNetwork } from '../../application/use-cases/CreateIpNetwork';
import { DeleteIpNetwork } from '../../application/use-cases/DeleteIpNetwork';
import { ListIpPools } from '../../application/use-cases/ListIpPools';
import { CreateIpPool } from '../../application/use-cases/CreateIpPool';
import { ListIpAssignments } from '../../application/use-cases/ListIpAssignments';
import { ListIpv6Networks } from '../../application/use-cases/ListIpv6Networks';
import { CreateIpv6Network } from '../../application/use-cases/CreateIpv6Network';
import { DeleteIpPool } from '../../application/use-cases/DeleteIpPool';
import { createIpNetworkRouter } from '../../infrastructure/http/routes/ipNetwork.routes';
import { InMemoryHardwareRepository } from '../../infrastructure/adapters/in-memory/InMemoryHardwareRepository';
import { ListHardwareAssets } from '../../application/use-cases/ListHardwareAssets';
import { CreateHardwareAsset } from '../../application/use-cases/CreateHardwareAsset';
import { UpdateHardwareAsset } from '../../application/use-cases/UpdateHardwareAsset';
import { DeleteHardwareAsset } from '../../application/use-cases/DeleteHardwareAsset';
import { createHardwareRouter } from '../../infrastructure/http/routes/hardware.routes';
import { UpdateTr069Profile } from '../../application/use-cases/UpdateTr069Profile';
import { DeleteTr069Profile } from '../../application/use-cases/DeleteTr069Profile';
import { DeleteTr069Device } from '../../application/use-cases/DeleteTr069Device';

function buildApp() {
  const app = express();
  app.use(express.json());

  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  app.use('/api/network-sites', createNetworkSiteRouter(
    new ListNetworkSites(networkSiteRepo),
    new GetNetworkSite(networkSiteRepo),
    new CreateNetworkSite(networkSiteRepo),
    new UpdateNetworkSite(networkSiteRepo),
    new DeleteNetworkSite(networkSiteRepo),
  ));

  const cpeRepo = new InMemoryCpeRepository();
  app.use('/api/cpe', createCpeRouter(
    new ListCpeDevices(cpeRepo),
    new GetCpeDevice(cpeRepo),
    new CreateCpeDevice(cpeRepo),
    new UpdateCpeDevice(cpeRepo),
    new DeleteCpeDevice(cpeRepo),
    new AssignCpeToClient(cpeRepo),
  ));

  const tr069Repo = new InMemoryTr069Repository();
  app.use('/api/tr069', createTr069Router(
    new ListTr069Profiles(tr069Repo),
    new CreateTr069Profile(tr069Repo),
    new UpdateTr069Profile(tr069Repo),
    new DeleteTr069Profile(tr069Repo),
    new ListTr069Devices(tr069Repo),
    new ProvisionDevice(tr069Repo),
    new DeleteTr069Device(tr069Repo),
  ));

  const ipRepo = new InMemoryIpNetworkRepository();
  app.use('/api', createIpNetworkRouter(
    new ListIpNetworks(ipRepo),
    new CreateIpNetwork(ipRepo),
    new DeleteIpNetwork(ipRepo),
    new ListIpPools(ipRepo),
    new CreateIpPool(ipRepo),
    new ListIpAssignments(ipRepo),
    new DeleteIpPool(ipRepo),
    new ListIpv6Networks(ipRepo),
    new CreateIpv6Network(ipRepo),
  ));

  const hwRepo = new InMemoryHardwareRepository();
  app.use('/api/hardware', createHardwareRouter(
    new ListHardwareAssets(hwRepo),
    new CreateHardwareAsset(hwRepo),
    new UpdateHardwareAsset(hwRepo),
    new DeleteHardwareAsset(hwRepo),
  ));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// Module 1: Network Sites routes
describe('GET /api/network-sites', () => {
  it('returns 200 with array of 5 sites', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/network-sites');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(5);
  });
});

// Module 2: CPE routes
describe('GET /api/cpe', () => {
  it('returns 200 with array of 10 devices', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/cpe');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(10);
  });
});

describe('POST /api/cpe', () => {
  it('returns 201 with new CPE device', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/cpe')
      .send({
        serialNumber: 'TEST-NEW-001',
        model: 'Test Router',
        manufacturer: 'Test',
        type: 'router',
        macAddress: 'AA:BB:CC:DD:EE:FF',
        ipAddress: null,
        status: 'unconfigured',
        clientId: null,
        clientName: null,
        nasId: null,
        networkSiteId: null,
        firmwareVersion: '1.0',
        lastSeen: null,
        signal: null,
        connectedAt: null,
        description: '',
      });

    expect(res.status).toBe(201);
    expect(res.body.serialNumber).toBe('TEST-NEW-001');
  });
});

// Module 3: TR-069 routes
describe('GET /api/tr069/profiles', () => {
  it('returns 200 with 3 profiles', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/tr069/profiles');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
  });
});

describe('GET /api/tr069/devices', () => {
  it('returns 200 with 8 devices', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/tr069/devices');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(8);
  });
});

// Module 4: IPv6 routes
describe('GET /api/ipv6-networks', () => {
  it('returns 200 with 2 IPv6 networks', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/ipv6-networks');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });
});

describe('POST /api/ipv6-networks', () => {
  it('returns 201 with new IPv6 network', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/ipv6-networks')
      .send({
        network: '2001:db8:cafe::/48',
        description: 'Test IPv6',
        delegationPrefix: 64,
        type: 'slaac',
        usedPrefixes: 0,
        totalPrefixes: 65536,
        status: 'active',
      });

    expect(res.status).toBe(201);
    expect(res.body.network).toBe('2001:db8:cafe::/48');
  });
});

// Module 5: Hardware routes
describe('GET /api/hardware', () => {
  it('returns 200 with 8 assets', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/hardware');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(8);
  });
});
