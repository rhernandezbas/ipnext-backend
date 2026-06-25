import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { ListNasServers } from '@application/use-cases/ListNasServers';
import { GetNasServer } from '@application/use-cases/GetNasServer';
import { OrchestratorSession } from '@domain/ports/RadiusOrchestratorGateway';
import { IpPool } from '@domain/entities/network';
import { NasServer } from '@domain/entities/nas';

/**
 * Contadores en vivo de NAS servers.
 *
 * Para NAS radius_orchestrator: clientCount = nº sesiones activas DISTINTAS con framedIp en algún
 * pool del NAS (atribuidas por POOLS, no por nasIp). lastSeen = max(startedAt) entre ellas.
 * Para NAS legacy: clientCount y lastSeen se mantienen como stored.
 * Si el orchestrator tira: cae al stored (never 500, best-effort).
 * displayType: "BRAS RADIUS" para radius_orchestrator, type crudo para el resto.
 */

const NAS_RADIUS: NasServer = {
  id: 'nas-radius',
  name: 'NE8000 BRAS',
  type: 'radius_orchestrator',
  ipAddress: '10.75.0.1',
  radiusSecret: '••••••••',
  nasIpAddress: '10.75.0.1',
  apiPort: null,
  apiLogin: null,
  apiPassword: null,
  status: 'active',
  lastSeen: '2026-01-01T00:00:00Z',
  clientCount: 0,
  description: 'NE8000 BRAS principal',
};

const NAS_LEGACY: NasServer = {
  id: 'nas-legacy',
  name: 'MikroTik Central',
  type: 'mikrotik_api',
  ipAddress: '192.168.1.1',
  radiusSecret: '••••••••',
  nasIpAddress: '192.168.1.1',
  apiPort: 8728,
  apiLogin: 'admin',
  apiPassword: '••••••••',
  status: 'active',
  lastSeen: '2026-03-15T10:00:00Z',
  clientCount: 55,
  description: 'Router legacy',
};

/** Pool ligado al NAS RADIUS — rango 100.64.10.1 – 100.64.10.10 */
const POOL_RADIUS: IpPool = {
  id: 'pool-r',
  name: 'cgnat-bras',
  networkId: 'net-r',
  rangeStart: '100.64.10.1',
  rangeEnd: '100.64.10.10',
  type: 'dynamic',
  assignedCount: 0,
  totalCount: 0,
  nasId: 'nas-radius',
  ipKind: 'cgnat',
};

function makeSession(overrides: Partial<OrchestratorSession> = {}): OrchestratorSession {
  return {
    sessionId: 'sess-1',
    username: 'user1',
    nasIp: '10.75.0.1',
    framedIp: '100.64.10.5',
    startedAt: '2026-06-01T10:00:00Z',
    bytesIn: 1000,
    bytesOut: 2000,
    callerId: null,
    ...overrides,
  };
}

function makeIpNetworkRepo(pools: IpPool[]): InMemoryIpNetworkRepository {
  const repo = new InMemoryIpNetworkRepository();
  // Limpiar seeds por defecto para trabajar solo con lo que sembramos
  (repo as unknown as { pools: IpPool[] }).pools = [];
  for (const pool of pools) {
    repo.seedPool(pool);
  }
  return repo;
}

function makeNasRepo(servers: NasServer[]): InMemoryNasRepository {
  const repo = new InMemoryNasRepository();
  (repo as unknown as { nasServers: NasServer[] }).nasServers = [...servers];
  return repo;
}

// ─── ListNasServers con live counters ───────────────────────────────────────

describe('ListNasServers — NAS live counters', () => {
  it('radius_orchestrator: clientCount = nº sesiones con framedIp en pool del NAS', async () => {
    const nasRepo = makeNasRepo([NAS_RADIUS, NAS_LEGACY]);
    const ipNetworkRepo = makeIpNetworkRepo([POOL_RADIUS]);
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      globalSessions: [
        makeSession({ sessionId: 's1', username: 'u1', framedIp: '100.64.10.5' }),
        makeSession({ sessionId: 's2', username: 'u2', framedIp: '100.64.10.7' }),
        makeSession({ sessionId: 's3', username: 'u3', framedIp: '100.64.10.99' }), // fuera del pool → no cuenta
      ],
    });

    const uc = new ListNasServers(nasRepo, ipNetworkRepo, orchestrator);
    const result = await uc.execute();

    const radiusNas = result.find(n => n.id === 'nas-radius')!;
    expect(radiusNas.clientCount).toBe(2); // s1 y s2 en el pool; s3 fuera
    expect(radiusNas.displayType).toBe('BRAS RADIUS');
  });

  it('radius_orchestrator: lastSeen = max(startedAt) de las sesiones en el pool', async () => {
    const nasRepo = makeNasRepo([NAS_RADIUS]);
    const ipNetworkRepo = makeIpNetworkRepo([POOL_RADIUS]);
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      globalSessions: [
        makeSession({ sessionId: 's1', framedIp: '100.64.10.2', startedAt: '2026-06-10T08:00:00Z' }),
        makeSession({ sessionId: 's2', framedIp: '100.64.10.3', startedAt: '2026-06-22T15:30:00Z' }),
      ],
    });

    const uc = new ListNasServers(nasRepo, ipNetworkRepo, orchestrator);
    const result = await uc.execute();

    const radiusNas = result.find(n => n.id === 'nas-radius')!;
    expect(radiusNas.lastSeen).toBe('2026-06-22T15:30:00.000Z');
  });

  it('radius_orchestrator: 0 sesiones en pool → clientCount=0 (real), lastSeen stored', async () => {
    const nasRepo = makeNasRepo([NAS_RADIUS]);
    const ipNetworkRepo = makeIpNetworkRepo([POOL_RADIUS]);
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      globalSessions: [
        makeSession({ sessionId: 's1', framedIp: '10.0.0.99' }), // fuera del pool
      ],
    });

    const uc = new ListNasServers(nasRepo, ipNetworkRepo, orchestrator);
    const result = await uc.execute();

    const radiusNas = result.find(n => n.id === 'nas-radius')!;
    expect(radiusNas.clientCount).toBe(0);
    expect(radiusNas.lastSeen).toBe(NAS_RADIUS.lastSeen); // stored, no sobrescrito
  });

  it('NAS legacy: clientCount y lastSeen se mantienen stored, displayType = type crudo', async () => {
    const nasRepo = makeNasRepo([NAS_LEGACY]);
    const ipNetworkRepo = makeIpNetworkRepo([]);
    const orchestrator = new InMemoryRadiusOrchestratorGateway({ globalSessions: [] });

    const uc = new ListNasServers(nasRepo, ipNetworkRepo, orchestrator);
    const result = await uc.execute();

    const legacyNas = result.find(n => n.id === 'nas-legacy')!;
    expect(legacyNas.clientCount).toBe(NAS_LEGACY.clientCount); // 55, sin tocar
    expect(legacyNas.lastSeen).toBe(NAS_LEGACY.lastSeen);       // stored
    expect(legacyNas.displayType).toBe('mikrotik_api');          // type crudo
  });

  it('orchestrator tira → cae al stored (best-effort, nunca 500)', async () => {
    const nasRepo = makeNasRepo([NAS_RADIUS]);
    const ipNetworkRepo = makeIpNetworkRepo([POOL_RADIUS]);
    const orchestrator = new InMemoryRadiusOrchestratorGateway({ globalSessionsUnreachable: true });

    const uc = new ListNasServers(nasRepo, ipNetworkRepo, orchestrator);
    const result = await uc.execute();

    const radiusNas = result.find(n => n.id === 'nas-radius')!;
    expect(radiusNas.clientCount).toBe(NAS_RADIUS.clientCount); // stored (0)
    expect(radiusNas.lastSeen).toBe(NAS_RADIUS.lastSeen);       // stored
    expect(radiusNas.displayType).toBe('BRAS RADIUS');           // displayType NUNCA degrada
  });

  it('UNA sola llamada global al orchestrator para múltiples NAS radius_orchestrator', async () => {
    const nasRadius2: NasServer = {
      ...NAS_RADIUS,
      id: 'nas-radius-2',
      name: 'NE8000-2',
    };
    const poolRadius2: IpPool = {
      ...POOL_RADIUS,
      id: 'pool-r2',
      nasId: 'nas-radius-2',
      rangeStart: '100.64.20.1',
      rangeEnd: '100.64.20.10',
    };

    const nasRepo = makeNasRepo([NAS_RADIUS, nasRadius2]);
    const ipNetworkRepo = makeIpNetworkRepo([POOL_RADIUS, poolRadius2]);

    let callCount = 0;
    const orchestrator = new InMemoryRadiusOrchestratorGateway({ globalSessions: [] });
    const origMethod = orchestrator.listActiveSessions.bind(orchestrator);
    orchestrator.listActiveSessions = async (...args) => {
      callCount++;
      return origMethod(...args);
    };

    const uc = new ListNasServers(nasRepo, ipNetworkRepo, orchestrator);
    await uc.execute();

    expect(callCount).toBe(1); // Una sola llamada global, no una por NAS
  });

  it('clientCount deduplica por username (misma persona, varias sesiones)', async () => {
    const nasRepo = makeNasRepo([NAS_RADIUS]);
    const ipNetworkRepo = makeIpNetworkRepo([POOL_RADIUS]);
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      globalSessions: [
        makeSession({ sessionId: 's1', username: 'user-multi', framedIp: '100.64.10.2' }),
        makeSession({ sessionId: 's2', username: 'user-multi', framedIp: '100.64.10.3' }),
        makeSession({ sessionId: 's3', username: 'user-single', framedIp: '100.64.10.4' }),
      ],
    });
    const uc = new ListNasServers(nasRepo, ipNetworkRepo, orchestrator);
    const result = await uc.execute();
    const radiusNas = result.find(n => n.id === 'nas-radius')!;
    expect(radiusNas.clientCount).toBe(2); // 2 usuarios unicos, no 3 sesiones
  });

  it('sin deps live (solo repo): devuelve stored con displayType = type', async () => {
    const nasRepo = makeNasRepo([NAS_LEGACY]);
    const uc = new ListNasServers(nasRepo);
    const result = await uc.execute();
    expect(result[0].displayType).toBe('mikrotik_api');
    expect(result[0].clientCount).toBe(55);
  });
});

// ─── GetNasServer con live counters ─────────────────────────────────────────

describe('GetNasServer — NAS live counters', () => {
  it('radius_orchestrator: clientCount en vivo + displayType = BRAS RADIUS', async () => {
    const nasRepo = makeNasRepo([NAS_RADIUS]);
    const ipNetworkRepo = makeIpNetworkRepo([POOL_RADIUS]);
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      globalSessions: [
        makeSession({ sessionId: 's1', username: 'u1', framedIp: '100.64.10.3' }),
        makeSession({ sessionId: 's2', username: 'u2', framedIp: '100.64.10.4' }),
        makeSession({ sessionId: 's3', username: 'u3', framedIp: '100.64.10.5' }),
      ],
    });

    const uc = new GetNasServer(nasRepo, ipNetworkRepo, orchestrator);
    const result = await uc.execute('nas-radius');

    expect(result).not.toBeNull();
    expect(result!.clientCount).toBe(3);
    expect(result!.displayType).toBe('BRAS RADIUS');
  });

  it('GetNasServer: NAS no encontrado → null (sin crash)', async () => {
    const nasRepo = makeNasRepo([NAS_RADIUS]);
    const ipNetworkRepo = makeIpNetworkRepo([]);
    const orchestrator = new InMemoryRadiusOrchestratorGateway({ globalSessions: [] });

    const uc = new GetNasServer(nasRepo, ipNetworkRepo, orchestrator);
    const result = await uc.execute('inexistente');

    expect(result).toBeNull();
  });

  it('GetNasServer legacy: stored sin tocar', async () => {
    const nasRepo = makeNasRepo([NAS_LEGACY]);
    const ipNetworkRepo = makeIpNetworkRepo([]);
    const orchestrator = new InMemoryRadiusOrchestratorGateway({ globalSessions: [] });

    const uc = new GetNasServer(nasRepo, ipNetworkRepo, orchestrator);
    const result = await uc.execute('nas-legacy');

    expect(result).not.toBeNull();
    expect(result!.clientCount).toBe(55);
    expect(result!.displayType).toBe('mikrotik_api');
  });

  it('GetNasServer orchestrator tira -> stored, displayType correcto', async () => {
    const nasRepo = makeNasRepo([NAS_RADIUS]);
    const ipNetworkRepo = makeIpNetworkRepo([POOL_RADIUS]);
    const orchestrator = new InMemoryRadiusOrchestratorGateway({ globalSessionsUnreachable: true });
    const uc = new GetNasServer(nasRepo, ipNetworkRepo, orchestrator);
    const result = await uc.execute('nas-radius');
    expect(result).not.toBeNull();
    expect(result!.clientCount).toBe(NAS_RADIUS.clientCount);
    expect(result!.displayType).toBe('BRAS RADIUS');
  });

  it('GetNasServer sin deps live (solo repo): stored con displayType = type', async () => {
    const nasRepo = makeNasRepo([NAS_LEGACY]);
    const uc = new GetNasServer(nasRepo);
    const result = await uc.execute('nas-legacy');
    expect(result).not.toBeNull();
    expect(result!.clientCount).toBe(55);
    expect(result!.displayType).toBe('mikrotik_api');
  });

  // Fix B — regresión del CRITICAL #1: cache per-request, no por instancia de use case
  it('2da llamada a execute() sobre la MISMA instancia refleja sesiones mutadas (no frozen)', async () => {
    const nasRepo = makeNasRepo([NAS_RADIUS]);
    const ipNetworkRepo = makeIpNetworkRepo([POOL_RADIUS]);

    // Gateway con sesiones mutables (monkey-patch igual que el test de "una sola llamada")
    let activeSessions: OrchestratorSession[] = [
      makeSession({ sessionId: 's1', username: 'u1', framedIp: '100.64.10.2' }),
    ];
    const orchestrator = new InMemoryRadiusOrchestratorGateway({ globalSessions: [] });
    orchestrator.listActiveSessions = async () => [...activeSessions];

    const uc = new GetNasServer(nasRepo, ipNetworkRepo, orchestrator);

    const first = await uc.execute('nas-radius');
    expect(first!.clientCount).toBe(1); // 1 sesión

    // Mutar: agregar una segunda sesión entre llamadas
    activeSessions = [
      makeSession({ sessionId: 's1', username: 'u1', framedIp: '100.64.10.2' }),
      makeSession({ sessionId: 's2', username: 'u2', framedIp: '100.64.10.3' }),
    ];

    const second = await uc.execute('nas-radius');
    expect(second!.clientCount).toBe(2); // refleja el cambio — no congelado en la 1ra respuesta
  });
});

// ─── Paginación del loop de sesiones ────────────────────────────────────────

describe('NasLiveStatsProvider — paginación del loop (Fix A)', () => {
  // Fix A — InMemoryRadiusOrchestratorGateway.listActiveSessions honra offset/limit:
  // con ≥250 sesiones el loop de paginación (PAGE_SIZE=100) itera 3 veces y cuenta TODAS.
  it('seedeo de 250 sesiones → clientCount cuenta TODAS (loop pagina correcto, termina, sin duplicar)', async () => {
    const nasRepo = makeNasRepo([NAS_RADIUS]);
    const ipNetworkRepo = makeIpNetworkRepo([POOL_RADIUS]);

    // 250 sesiones con framedIp dentro del pool (100.64.10.1–10)
    // Usamos IPs rotando en el pool; lo que importa es que TODAS estén dentro del rango.
    const sessions: OrchestratorSession[] = Array.from({ length: 250 }, (_, i) => {
      const ipSuffix = (i % 10) + 1; // 1–10, todos dentro del pool rangeStart/rangeEnd
      return makeSession({
        sessionId: `s${i}`,
        username: `user-${i}`, // todos distintos → clientCount = 250
        framedIp: `100.64.10.${ipSuffix}`,
      });
    });

    const orchestrator = new InMemoryRadiusOrchestratorGateway({ globalSessions: sessions });

    const uc = new ListNasServers(nasRepo, ipNetworkRepo, orchestrator);
    const result = await uc.execute();

    const radiusNas = result.find(n => n.id === 'nas-radius')!;
    // El loop debe paginar 3 veces (100 + 100 + 50) y contar las 250 sin duplicar ni saltear.
    expect(radiusNas.clientCount).toBe(250);
  });
});
