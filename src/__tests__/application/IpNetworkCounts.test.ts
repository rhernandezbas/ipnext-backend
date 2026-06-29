import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { ListIpPools } from '@application/use-cases/ListIpPools';
import { ListIpNetworks } from '@application/use-cases/ListIpNetworks';
import { AssignedIpsProvider } from '@application/services/AssignedIpsProvider';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { IpNetwork, IpPool } from '@domain/entities/network';

/**
 * Counts de Gestión de Red IP. La verdad de las IPs asignadas vive en el RADIUS
 * (radius_orchestrator → orchestrator.listAssignedIps) o en el router (resto). La tabla
 * IpAssignment está vacía en prod: NO se usa para contar.
 *
 * Fixture: red CGNAT 100.64.10.0/24 con un pool .2-.5 ligado al NAS '1' (mikrotik_api),
 * y red RADIUS 100.64.30.0/24 con un pool .2-.5 ligado al NAS '3' (radius_orchestrator).
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

  it('radius_orchestrator pool: assignedCount viene del RADIUS (orchestrator), NO del router', async () => {
    repo.seedNetwork(NET_RADIUS);
    repo.seedPool(POOL_RADIUS);
    orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIps: ['100.64.30.2', '100.64.30.3'] });
    // El router tiene una IP en rango que NO debe contar para un radius_orchestrator.
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

  it('no disponible (null): si el router sigue caído tras los reintentos, el pool sale con assignedCount null, no rompe la lista', async () => {
    repo.seedNetwork(NET_API);
    repo.seedPool(POOL_API);
    repo.seedNetwork(NET_RADIUS);
    repo.seedPool(POOL_RADIUS);
    // router caído para el NAS '1' (192.168.1.1): tras los reintentos la fuente NO se recupera
    // → assignedCount = null ("no disponible"), NO 0 (un 0-por-fallo MENTIRÍA). El radius sigue OK.
    router = new InMemoryRouterGateway({ unreachable: ['192.168.1.1'] });
    orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIps: ['100.64.30.2'] });

    const uc = new ListIpPools(repo, nasRepo, router, orchestrator);
    const pools = await uc.execute();

    const apiPool = pools.find(p => p.id === 'pool-api')!;
    const radiusPool = pools.find(p => p.id === 'pool-radius')!;
    expect(apiPool.totalCount).toBe(4);          // el total del rango siempre se computa
    expect(apiPool.assignedCount).toBeNull();    // router caído → no disponible (null), NO 0
    expect(radiusPool.assignedCount).toBe(1);    // el resto de la lista sobrevive con su número real
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
    // Red con dos pools de NAS distintos: uno mikrotik_api (router) y otro radius_orchestrator.
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

  it('no disponible (null): red cuyo NAS sigue caído tras los reintentos sale con usedIps/freeIps null y NO rompe la lista', async () => {
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
    expect(apiNet.totalIps).toBe(254);   // el total del CIDR siempre se computa
    expect(apiNet.usedIps).toBeNull();   // NAS caído → no disponible (null), NO 0
    expect(apiNet.freeIps).toBeNull();   // si used no es confiable, free tampoco lo es
    expect(radiusNet.usedIps).toBe(1);   // sobrevive con su número real
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

/**
 * AssignedIpsProvider — resiliencia: RETRY con backoff para absorber el hipo transitorio,
 * y "no disponible" (null) si la fuente sigue caída tras los reintentos. El bug raíz era
 * `fetch.catch(() => [])`: un 0-por-fallo es indistinguible de un 0-real → el contador MENTÍA.
 *
 * Fake router inline que CUENTA llamadas e implementa sólo lo que el provider usa
 * (`listAssignedIps`). NAS '1' (InMemoryNasRepository) es mikrotik_api → rutea por el router.
 */
function countingRouter(behavior: (call: number) => string[]): {
  gw: PppoeRouterGateway;
  calls: () => number;
} {
  let calls = 0;
  const gw = {
    async listAssignedIps(): Promise<string[]> {
      calls++;
      return behavior(calls); // puede tirar para simular la fuente caída
    },
  } as unknown as PppoeRouterGateway;
  return { gw, calls: () => calls };
}

/**
 * Variante async de countingRouter: el comportamiento devuelve una PROMESA, para modelar fetches
 * lentos/colgados (tests del timeout por intento). `pendingForever()` nunca settlea y NO usa
 * timers → simula la fuente colgada sin dejar handles abiertos que cuelguen a jest.
 */
function asyncRouter(behavior: (call: number) => Promise<string[]>): {
  gw: PppoeRouterGateway;
  calls: () => number;
} {
  let calls = 0;
  const gw = {
    listAssignedIps(): Promise<string[]> {
      calls++;
      return behavior(calls);
    },
  } as unknown as PppoeRouterGateway;
  return { gw, calls: () => calls };
}

const pendingForever = (): Promise<string[]> => new Promise<string[]>(() => { /* nunca settlea */ });

describe('AssignedIpsProvider — retry/backoff y "no disponible" (null)', () => {
  let nasRepo: InMemoryNasRepository;
  let orchestrator: InMemoryRadiusOrchestratorGateway;

  beforeEach(() => {
    nasRepo = new InMemoryNasRepository();
    orchestrator = new InMemoryRadiusOrchestratorGateway(); // dummy: NAS '1' va por el router
  });

  it('RETRY: la fuente falla 2 veces y resuelve a la 3ra → devuelve las IPs (no null)', async () => {
    const { gw, calls } = countingRouter((c) => {
      if (c <= 2) throw new Error('hipo transitorio');
      return ['100.64.10.3', '100.64.10.4'];
    });
    const provider = new AssignedIpsProvider(nasRepo, gw, orchestrator, { retries: 2, backoffMs: 0 });

    const result = await provider.forNas('1');

    expect(result).toEqual(['100.64.10.3', '100.64.10.4']);
    expect(calls()).toBe(3); // 1 intento inicial + 2 reintentos; la 3ra resolvió
  });

  it('RETRY agotado: la fuente falla SIEMPRE → devuelve null (NO [])', async () => {
    const { gw, calls } = countingRouter(() => { throw new Error('NAS caído'); });
    const provider = new AssignedIpsProvider(nasRepo, gw, orchestrator, { retries: 2, backoffMs: 0 });

    const result = await provider.forNas('1');

    expect(result).toBeNull();   // tras agotar los reintentos: "no disponible", NO un 0 mentiroso
    expect(calls()).toBe(3);     // intentó 3 veces (1 + 2 reintentos) y se rindió
  });

  it('sin nasId / NAS inexistente → [] (0 REAL, no es fallo)', async () => {
    const { gw } = countingRouter(() => []);
    const provider = new AssignedIpsProvider(nasRepo, gw, orchestrator, { retries: 2, backoffMs: 0 });

    expect(await provider.forNas(null)).toEqual([]);
    expect(await provider.forNas('no-existe')).toEqual([]);
  });

  it('TIMEOUT por intento: si TODOS los intentos exceden perAttemptTimeoutMs → null (acota la latencia)', async () => {
    // Fetch que cuelga para siempre: cada intento debe abortar por timeout (no esperar al gateway).
    const { gw, calls } = asyncRouter(() => pendingForever());
    const provider = new AssignedIpsProvider(nasRepo, gw, orchestrator, {
      retries: 2, backoffMs: 0, perAttemptTimeoutMs: 50,
    });

    const result = await provider.forNas('1');

    expect(result).toBeNull(); // 3 intentos timeoutearon → "no disponible", sin colgar el endpoint
    expect(calls()).toBe(3);   // 1 + 2 reintentos, cada uno abortado por su propio timeout
  });

  it('TIMEOUT por intento: el 1er intento se cuelga (timeout) pero el 2º resuelve rápido → IPs', async () => {
    const { gw, calls } = asyncRouter((c) =>
      c === 1 ? pendingForever() : Promise.resolve(['100.64.10.3']),
    );
    const provider = new AssignedIpsProvider(nasRepo, gw, orchestrator, {
      retries: 2, backoffMs: 0, perAttemptTimeoutMs: 50,
    });

    const result = await provider.forNas('1');

    expect(result).toEqual(['100.64.10.3']); // el timeout del 1er intento no impide recuperarse
    expect(calls()).toBe(2);
  });

  it('retries:0 → un SOLO intento, sin reintentos (la opción retries se cablea de verdad)', async () => {
    const { gw, calls } = asyncRouter(() => Promise.reject(new Error('caído')));
    const provider = new AssignedIpsProvider(nasRepo, gw, orchestrator, { retries: 0, backoffMs: 0 });

    const result = await provider.forNas('1');

    expect(result).toBeNull();
    expect(calls()).toBe(1); // retries:0 ⇒ no reintenta; si alguien hardcodea this.retries=2, rompe
  });
});

describe('Propagación de "no disponible" por el path RADIUS (orchestrator caído)', () => {
  let repo: InMemoryIpNetworkRepository;
  let nasRepo: InMemoryNasRepository;
  let router: InMemoryRouterGateway;

  beforeEach(() => {
    repo = emptyRepo();
    nasRepo = new InMemoryNasRepository();
    router = new InMemoryRouterGateway();
  });

  it('orchestrator caído → ListIpPools.assignedCount null y ListIpNetworks usedIps/freeIps null', async () => {
    repo.seedNetwork(NET_RADIUS);
    repo.seedPool(POOL_RADIUS);
    // NAS '3' (radius_orchestrator) → fuente = orchestrator.listAssignedIps, que acá tira SIEMPRE.
    const downOrch = new InMemoryRadiusOrchestratorGateway({ assignedIpsUnreachable: true });

    const pools = await new ListIpPools(repo, nasRepo, router, downOrch).execute();
    const radiusPool = pools.find(p => p.id === 'pool-radius')!;
    expect(radiusPool.totalCount).toBe(4);          // total del rango: siempre se computa
    expect(radiusPool.assignedCount).toBeNull();    // RADIUS caído → no disponible

    const nets = await new ListIpNetworks(repo, nasRepo, router, downOrch).execute();
    const radiusNet = nets.find(n => n.id === 'net-radius')!;
    expect(radiusNet.totalIps).toBe(254);           // total del CIDR: siempre se computa
    expect(radiusNet.usedIps).toBeNull();           // RADIUS caído → no disponible
    expect(radiusNet.freeIps).toBeNull();
  });
});
