import { FindFreeIp } from '@application/use-cases/FindFreeIp';
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { NoFreeIpError, NoPoolForNasTypeError } from '@domain/errors/network';
import { NasNotFoundError } from '@domain/errors/pppoe';

/**
 * FindFreeIp — primer IP libre de un pool (rango menos los `remote-address` vivos del router).
 * Tests con adapters in-memory (pool/nas/gateway). NUNCA tocan un router real.
 *
 * Convención del fixture: NAS '1' (ipAddress 192.168.1.1) tiene dos pools sembrados a mano:
 *   - cgnat:  100.64.10.2 .. 100.64.10.5   (gateway 100.64.10.1, network 100.64.10.0/24)
 *   - public: 190.7.247.2 .. 190.7.247.5   (gateway 190.7.247.1, network 190.7.247.0/24)
 */
function buildRepo(): InMemoryIpNetworkRepository {
  const repo = new InMemoryIpNetworkRepository();
  // Red CGNAT + pool acotado para hacer los asserts deterministas.
  repo.seedNetwork({
    id: 'net-cgnat',
    network: '100.64.10.0/24',
    gateway: '100.64.10.1',
    dns1: '',
    dns2: '',
    description: 'MercAccesoSur CGNAT',
    partnerId: null,
    type: 'static',
    totalIps: 254,
    usedIps: 0,
    freeIps: 254,
  });
  repo.seedPool({
    id: 'pool-cgnat',
    name: 'mercaccesosur-cgnat',
    networkId: 'net-cgnat',
    rangeStart: '100.64.10.2',
    rangeEnd: '100.64.10.5',
    type: 'dynamic',
    assignedCount: 0,
    totalCount: 4,
    nasId: '1',
    ipKind: 'cgnat',
  });
  repo.seedNetwork({
    id: 'net-public',
    network: '190.7.247.0/24',
    gateway: '190.7.247.1',
    dns1: '',
    dns2: '',
    description: 'MercAccesoSur público',
    partnerId: null,
    type: 'static',
    totalIps: 254,
    usedIps: 0,
    freeIps: 254,
  });
  repo.seedPool({
    id: 'pool-public',
    name: 'mercaccesosur-public',
    networkId: 'net-public',
    rangeStart: '190.7.247.2',
    rangeEnd: '190.7.247.5',
    type: 'static',
    assignedCount: 0,
    totalCount: 4,
    nasId: '1',
    ipKind: 'public',
  });
  // Red + pool para el NAS '3' (radius_orchestrator): la fuente de IPs asignadas es el RADIUS,
  // no el router. Mismo rango acotado para asserts deterministas.
  repo.seedNetwork({
    id: 'net-radius',
    network: '100.64.30.0/24',
    gateway: '100.64.30.1',
    dns1: '',
    dns2: '',
    description: 'sucursal RADIUS CGNAT',
    partnerId: null,
    type: 'static',
    totalIps: 254,
    usedIps: 0,
    freeIps: 254,
  });
  repo.seedPool({
    id: 'pool-radius',
    name: 'sucursal-radius-cgnat',
    networkId: 'net-radius',
    rangeStart: '100.64.30.2',
    rangeEnd: '100.64.30.5',
    type: 'dynamic',
    assignedCount: 0,
    totalCount: 4,
    nasId: '3',
    ipKind: 'cgnat',
  });
  return repo;
}

const NAS1 = { ipAddress: '192.168.1.1', apiPort: 8728 };
const NAS3 = { ipAddress: '10.0.0.5', apiPort: 8728 };

describe('FindFreeIp', () => {
  let repo: InMemoryIpNetworkRepository;
  let nasRepo: InMemoryNasRepository;
  let router: InMemoryRouterGateway;
  let orchestrator: InMemoryRadiusOrchestratorGateway;
  let uc: FindFreeIp;

  beforeEach(() => {
    repo = buildRepo();
    nasRepo = new InMemoryNasRepository();
    router = new InMemoryRouterGateway();
    orchestrator = new InMemoryRadiusOrchestratorGateway();
    uc = new FindFreeIp(repo, nasRepo, router, orchestrator);
  });

  it('devuelve el primer IP del rango cuando no hay nada asignado (cgnat)', async () => {
    const ip = await uc.execute({ nasId: '1', type: 'cgnat' });
    expect(ip).toBe('100.64.10.2');
  });

  it('devuelve el primer IP del rango público', async () => {
    const ip = await uc.execute({ nasId: '1', type: 'public' });
    expect(ip).toBe('190.7.247.2');
  });

  it('saltea los IPs ya asignados en el router (remote-address de /ppp secret)', async () => {
    // .2 y .3 ya están vivos en el router → el primer libre es .4
    await router.createSecret(NAS1, { username: 'u2', password: 'p', remoteAddress: '100.64.10.2' });
    await router.createSecret(NAS1, { username: 'u3', password: 'p', remoteAddress: '100.64.10.3' });
    const ip = await uc.execute({ nasId: '1', type: 'cgnat' });
    expect(ip).toBe('100.64.10.4');
  });

  it('saltea gateway/network/broadcast aunque caigan dentro del rango', async () => {
    // Pool que arranca en el network address y abarca gateway y broadcast.
    repo.seedNetwork({
      id: 'net-edge',
      network: '100.64.20.0/24',
      gateway: '100.64.20.1',
      dns1: '', dns2: '', description: 'edge', partnerId: null,
      type: 'static', totalIps: 254, usedIps: 0, freeIps: 254,
    });
    repo.seedPool({
      id: 'pool-edge',
      name: 'edge',
      networkId: 'net-edge',
      rangeStart: '100.64.20.0',   // network address (debe saltearse)
      rangeEnd: '100.64.20.255',   // broadcast (debe saltearse)
      type: 'dynamic', assignedCount: 0, totalCount: 256,
      nasId: '2', ipKind: 'cgnat',
    });
    // NAS '2' (ipAddress 192.168.2.1) no tiene secrets → todo libre salvo edges.
    const ip = await uc.execute({ nasId: '2', type: 'cgnat' });
    expect(ip).toBe('100.64.20.2'); // .0 network, .1 gateway → primer libre .2
  });

  it('lanza NoFreeIpError cuando todo el rango está asignado', async () => {
    for (const last of [2, 3, 4, 5]) {
      await router.createSecret(NAS1, {
        username: `u${last}`,
        password: 'p',
        remoteAddress: `100.64.10.${last}`,
      });
    }
    await expect(uc.execute({ nasId: '1', type: 'cgnat' })).rejects.toBeInstanceOf(NoFreeIpError);
  });

  it('lanza NoPoolForNasTypeError cuando el NAS no tiene pool de ese tipo', async () => {
    // NAS '2' (ubiquiti) existe pero no tiene ningún pool sembrado en buildRepo.
    await expect(uc.execute({ nasId: '2', type: 'cgnat' })).rejects.toBeInstanceOf(
      NoPoolForNasTypeError,
    );
  });

  it('lanza NasNotFoundError cuando el NAS no existe', async () => {
    await expect(uc.execute({ nasId: '999', type: 'cgnat' })).rejects.toBeInstanceOf(
      NasNotFoundError,
    );
  });

  describe('fuente de IPs asignadas ruteada por nas.type', () => {
    it('radius_orchestrator: usa el RADIUS (orchestrator.listAssignedIps), NO el router', async () => {
      // El router NO sabe de estas IPs; sólo el RADIUS (radreply Framed-IP) las tiene.
      // .2 y .3 asignadas en RADIUS → el primer libre debe ser .4.
      orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIps: ['100.64.30.2', '100.64.30.3'] });
      // El router tiene un secret que NO debe contar (es la fuente equivocada para este NAS).
      await router.createSecret(NAS3, { username: 'mk', password: 'p', remoteAddress: '100.64.30.4' });
      uc = new FindFreeIp(repo, nasRepo, router, orchestrator);

      const ip = await uc.execute({ nasId: '3', type: 'cgnat' });
      expect(ip).toBe('100.64.30.4'); // libre en RADIUS aunque el router lo tenga
    });

    it('radius_orchestrator con RADIUS vacío: primer IP del rango (el router se ignora)', async () => {
      // El router tiene .2 ocupado, pero para radius_orchestrator el router NO es la fuente.
      await router.createSecret(NAS3, { username: 'mk', password: 'p', remoteAddress: '100.64.30.2' });
      uc = new FindFreeIp(repo, nasRepo, router, orchestrator); // orchestrator default → []

      const ip = await uc.execute({ nasId: '3', type: 'cgnat' });
      expect(ip).toBe('100.64.30.2'); // libre en RADIUS (lista vacía)
    });

    it('NAS no-radius (mikrotik_api): usa el router, NO el orchestrator', async () => {
      // El RADIUS reporta .2 asignada, pero para un mikrotik_api NO debe consultarse.
      orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIps: ['100.64.10.2'] });
      uc = new FindFreeIp(repo, nasRepo, router, orchestrator);

      // El router no tiene nada → primer libre = .2 (ignora el RADIUS).
      const ip = await uc.execute({ nasId: '1', type: 'cgnat' });
      expect(ip).toBe('100.64.10.2');
    });
  });

  // Un NAS puede tener N pools del mismo tipo (RDA2: muchos /24 CGNAT, unos llenos y otros libres).
  // El allocator debe iterar los pools y devolver el primer IP libre del primer pool con lugar,
  // SALTEANDO los pools llenos. (NAS '1' usa el router como fuente de IPs asignadas.)
  describe('N pools del mismo tipo en un NAS', () => {
    function seedSecondCgnatPool() {
      repo.seedNetwork({
        id: 'net-cgnat2',
        network: '100.64.11.0/24',
        gateway: '100.64.11.1',
        dns1: '', dns2: '', description: 'cgnat2', partnerId: null,
        type: 'static', totalIps: 254, usedIps: 0, freeIps: 254,
      });
      repo.seedPool({
        id: 'pool-cgnat2',
        name: 'mercaccesosur-cgnat-2',
        networkId: 'net-cgnat2',
        rangeStart: '100.64.11.2',
        rangeEnd: '100.64.11.5',
        type: 'dynamic', assignedCount: 0, totalCount: 4,
        nasId: '1', ipKind: 'cgnat',
      });
    }

    it('si el primer pool cgnat está LLENO, asigna del siguiente con lugar', async () => {
      seedSecondCgnatPool();
      // Llenar el PRIMER pool (100.64.10.2-5) en el router.
      for (const last of [2, 3, 4, 5]) {
        await router.createSecret(NAS1, { username: `u${last}`, password: 'p', remoteAddress: `100.64.10.${last}` });
      }
      const ip = await uc.execute({ nasId: '1', type: 'cgnat' });
      expect(ip).toBe('100.64.11.2'); // primer libre del SEGUNDO pool
    });

    it('si TODOS los pools cgnat están llenos, lanza NoFreeIpError', async () => {
      seedSecondCgnatPool();
      for (const last of [2, 3, 4, 5]) {
        await router.createSecret(NAS1, { username: `a${last}`, password: 'p', remoteAddress: `100.64.10.${last}` });
        await router.createSecret(NAS1, { username: `b${last}`, password: 'p', remoteAddress: `100.64.11.${last}` });
      }
      await expect(uc.execute({ nasId: '1', type: 'cgnat' })).rejects.toBeInstanceOf(NoFreeIpError);
    });

    it('no mezcla tipos: un pool public lleno no bloquea la asignación cgnat', async () => {
      seedSecondCgnatPool();
      // Llenar el primer cgnat → debe ir al segundo, sin que el pool public interfiera.
      for (const last of [2, 3, 4, 5]) {
        await router.createSecret(NAS1, { username: `c${last}`, password: 'p', remoteAddress: `100.64.10.${last}` });
      }
      const ip = await uc.execute({ nasId: '1', type: 'cgnat' });
      expect(ip).toBe('100.64.11.2');
    });

    it('con 2 pools cgnat LIBRES, asigna del primero por orden de NOMBRE (determinístico)', async () => {
      seedSecondCgnatPool();
      // Ambos libres → debe tomar del primero por nombre ('mercaccesosur-cgnat' < 'mercaccesosur-cgnat-2'),
      // no del orden de inserción. Bloquea el orderBy del repo (asignación predecible, packea pools).
      const ip = await uc.execute({ nasId: '1', type: 'cgnat' });
      expect(ip).toBe('100.64.10.2');
    });
  });
});
