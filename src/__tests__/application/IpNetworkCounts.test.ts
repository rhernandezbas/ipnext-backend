import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { ListIpPools } from '@application/use-cases/ListIpPools';
import { ListIpNetworks } from '@application/use-cases/ListIpNetworks';
import { IpNetwork, IpPool } from '@domain/entities/network';

/**
 * Counts de Gestión de Red IP. La verdad de las IPs asignadas vive en el RADIUS
 * (mikrotik_radius → orchestrator.listAssignedIps) o en el router (resto). La tabla
 * IpAssignment está vacía en prod: NO se usa para contar.
 *
 * Fixture: red CGNAT 100.64.10.0/24 con un pool .2-.5 ligado al NAS '1' (mikrotik_api),
 * y red RADIUS 100.64.30.0/24 con un pool .2-.5 ligado al NAS '3' (mikrotik_radius).
 */
const NET_API: IpNetwork = {
  id: 'net-api',
  network: '100.64.10.0/24',
  gateway: '100.64.10.1',
  dns1: '', dns2: '', description: 'api cgnat', partnerId: null,
  type: 'static', totalIps: 0, usedIps: 0, freeIps: 0,
};
const POOL_API: IpPool = {
  id: 'pool-api', name: 'api-cgnat', networkId: 'net-api',
  rangeStart: '100.64.10.2', rangeEnd: '100.64.10.5',
  type: 'dynamic', assignedCount: 0, totalCount: 0, nasId: '1', ipKind: 'cgnat',
};
const NET_RADIUS: IpNetwork = {
  id: 'net-radius',
  network: '100.64.30.0/24',
  gateway: '100.64.30.1',
  dns1: '', dns2: '', description: 'radius cgnat', partnerId: null,
  type: 'static', totalIps: 0, usedIps: 0, freeIps: 0,
};
const POOL_RADIUS: IpPool = {
  id: 'pool-radius', name: 'radius-cgnat', networkId: 'net-radius',
  rangeStart: '100.64.30.2', rangeEnd: '100.64.30.5',
  type: 'dynamic', assignedCount: 0, totalCount: 0, nasId: '3', ipKind: 'cgnat',
};

function emptyRepo(): InMemoryIpNetworkRepository {
  const repo = new InMemoryIpNetworkRepository();
  // Vaciar los seeds default para asertar sólo sobre lo que sembramos.
  (repo as unknown as { networks: IpNetwork[] }).networks = [];
  (repo as unknown as { pools: IpPool[] }).pools = [];
  return repo;
}

describe('ListIpPools — counts ruteados por nas.type', () => {
  let repo: InMemoryIpNetworkRepository;
  let nasRepo: InMemoryNasRepository;
  let router: InMemoryRouterGateway;
  let orchestrator: InMemoryRadiusOrchestratorGateway;

  beforeEach(() => {
    repo = emptyRepo();
    nasRepo = new InMemoryNasRepository();
    router = new InMemoryRouterGateway();
    orchestrator = new InMemoryRadiusOrchestratorGateway();
  });

  it('mikrotik_api pool: assignedCount = router IPs en rango; total = tamaño del rango', async () => {
    repo.seedNetwork(NET_API);
    repo.seedPool(POOL_API);
    // NAS '1' = mikrotik_api (ipAddress 192.168.1.1) → fuente router.
    await router.createSecret({ ipAddress: '192.168.1.1', apiPort: 8728 }, { username: 'u3', password: 'p', remoteAddress: '100.64.10.3' });
    await router.createSecret({ ipAddress: '192.168.1.1', apiPort: 8728 }, { username: 'u4', password: 'p', remoteAddress: '100.64.10.4' });
    // Fuera de rango: no debe contar.
    await router.createSecret({ ipAddress: '192.168.1.1', apiPort: 8728 }, { username: 'u9', password: 'p', remoteAddress: '100.64.10.99' });

    const uc = new ListIpPools(repo, nasRepo, router, orchestrator);
    const pools = await uc.execute();
    const pool = pools.find(p => p.id === 'pool-api')!;

    expect(pool.totalCount).toBe(4);     // .2 .3 .4 .5
    expect(pool.assignedCount).toBe(2);  // .3 .4 en rango; .99 fuera
  });

  it('mikrotik_radius pool: assignedCount viene del RADIUS (orchestrator), NO del router', async () => {
    repo.seedNetwork(NET_RADIUS);
    repo.seedPool(POOL_RADIUS);
    orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIps: ['100.64.30.2', '100.64.30.3'] });
    // El router tiene una IP en rango que NO debe contar para un mikrotik_radius.
    await router.createSecret({ ipAddress: '10.0.0.5', apiPort: 8728 }, { username: 'mk', password: 'p', remoteAddress: '100.64.30.5' });

    const uc = new ListIpPools(repo, nasRepo, router, orchestrator);
    const pools = await uc.execute();
    const pool = pools.find(p => p.id === 'pool-radius')!;

    expect(pool.totalCount).toBe(4);
    expect(pool.assignedCount).toBe(2); // del RADIUS, ignora el router
  });

  it('pool sin nasId: assignedCount 0, total del rango (no hay fuente de asignadas)', async () => {
    repo.seedNetwork(NET_API);
    repo.seedPool({ ...POOL_API, id: 'pool-orphan', nasId: null });

    const uc = new ListIpPools(repo, nasRepo, router, orchestrator);
    const pools = await uc.execute();
    const pool = pools.find(p => p.id === 'pool-orphan')!;

    expect(pool.totalCount).toBe(4);
    expect(pool.assignedCount).toBe(0);
  });

  it('degrada: si el router tira (NAS unreachable) el pool sale con assignedCount 0, no rompe la lista', async () => {
    repo.seedNetwork(NET_API);
    repo.seedPool(POOL_API);
    repo.seedNetwork(NET_RADIUS);
    repo.seedPool(POOL_RADIUS);
    // router caído para el NAS '1' (192.168.1.1) → su pool degrada; el radius sigue OK.
    router = new InMemoryRouterGateway({ unreachable: ['192.168.1.1'] });
    orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIps: ['100.64.30.2'] });

    const uc = new ListIpPools(repo, nasRepo, router, orchestrator);
    const pools = await uc.execute();

    const apiPool = pools.find(p => p.id === 'pool-api')!;
    const radiusPool = pools.find(p => p.id === 'pool-radius')!;
    expect(apiPool.totalCount).toBe(4);
    expect(apiPool.assignedCount).toBe(0);   // router caído → degrada
    expect(radiusPool.assignedCount).toBe(1); // el resto de la lista sobrevive
  });

  it('no hace N+1: dos pools del MISMO NAS consultan la fuente una sola vez', async () => {
    repo.seedNetwork(NET_API);
    repo.seedPool(POOL_API);
    repo.seedPool({ ...POOL_API, id: 'pool-api-2', rangeStart: '100.64.10.6', rangeEnd: '100.64.10.9' });

    let calls = 0;
    const original = router.listAssignedIps.bind(router);
    router.listAssignedIps = async (nas) => { calls++; return original(nas); };

    const uc = new ListIpPools(repo, nasRepo, router, orchestrator);
    await uc.execute();

    expect(calls).toBe(1); // un solo fetch para los dos pools del NAS '1'
  });
});

describe('ListIpNetworks — counts ruteados por nas.type', () => {
  let repo: InMemoryIpNetworkRepository;
  let nasRepo: InMemoryNasRepository;
  let router: InMemoryRouterGateway;
  let orchestrator: InMemoryRadiusOrchestratorGateway;

  beforeEach(() => {
    repo = emptyRepo();
    nasRepo = new InMemoryNasRepository();
    router = new InMemoryRouterGateway();
    orchestrator = new InMemoryRadiusOrchestratorGateway();
  });

  it('totalIps = usables del CIDR; usedIps = asignadas en el CIDR; free = total - used', async () => {
    repo.seedNetwork(NET_RADIUS);
    repo.seedPool(POOL_RADIUS);
    orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIps: ['100.64.30.2', '100.64.30.3', '100.64.30.4'] });

    const uc = new ListIpNetworks(repo, nasRepo, router, orchestrator);
    const nets = await uc.execute();
    const net = nets.find(n => n.id === 'net-radius')!;

    expect(net.totalIps).toBe(254);   // /24 usables
    expect(net.usedIps).toBe(3);      // .2 .3 .4 dentro del CIDR
    expect(net.freeIps).toBe(251);    // 254 - 3
  });

  it('cuenta asignadas de TODOS los NAS cuyos pools cuelgan de la red (sin duplicar)', async () => {
    // Red con dos pools de NAS distintos: uno mikrotik_api (router) y otro mikrotik_radius.
    const sharedNet: IpNetwork = { ...NET_API, id: 'net-shared' };
    repo.seedNetwork(sharedNet);
    repo.seedPool({ ...POOL_API, id: 'p-api', networkId: 'net-shared', nasId: '1', rangeStart: '100.64.10.2', rangeEnd: '100.64.10.10' });
    repo.seedPool({ ...POOL_API, id: 'p-rad', networkId: 'net-shared', nasId: '3', rangeStart: '100.64.10.20', rangeEnd: '100.64.10.30' });

    await router.createSecret({ ipAddress: '192.168.1.1', apiPort: 8728 }, { username: 'a', password: 'p', remoteAddress: '100.64.10.5' });
    orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIps: ['100.64.10.25'] });

    const uc = new ListIpNetworks(repo, nasRepo, router, orchestrator);
    const nets = await uc.execute();
    const net = nets.find(n => n.id === 'net-shared')!;

    expect(net.usedIps).toBe(2); // .5 (router) + .25 (radius)
  });

  it('degrada: red cuyo NAS está caído sale con usedIps 0 y NO rompe la lista', async () => {
    repo.seedNetwork(NET_API);
    repo.seedPool(POOL_API);
    repo.seedNetwork(NET_RADIUS);
    repo.seedPool(POOL_RADIUS);
    router = new InMemoryRouterGateway({ unreachable: ['192.168.1.1'] });
    orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIps: ['100.64.30.2'] });

    const uc = new ListIpNetworks(repo, nasRepo, router, orchestrator);
    const nets = await uc.execute();

    const apiNet = nets.find(n => n.id === 'net-api')!;
    const radiusNet = nets.find(n => n.id === 'net-radius')!;
    expect(apiNet.totalIps).toBe(254);
    expect(apiNet.usedIps).toBe(0);   // NAS caído → degrada a 0
    expect(apiNet.freeIps).toBe(254);
    expect(radiusNet.usedIps).toBe(1); // sobrevive
  });

  it('red sin pools: totalIps del CIDR, usedIps 0', async () => {
    repo.seedNetwork(NET_API);

    const uc = new ListIpNetworks(repo, nasRepo, router, orchestrator);
    const nets = await uc.execute();
    const net = nets.find(n => n.id === 'net-api')!;

    expect(net.totalIps).toBe(254);
    expect(net.usedIps).toBe(0);
    expect(net.freeIps).toBe(254);
  });
});
