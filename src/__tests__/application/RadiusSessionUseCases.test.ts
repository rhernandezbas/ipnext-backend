import { InMemoryRadiusSessionRepository } from '../../infrastructure/adapters/in-memory/InMemoryRadiusSessionRepository';
import { InMemoryPppoeServiceRepository } from '../../infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { ListRadiusSessions } from '../../application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '../../application/use-cases/DisconnectSession';
import { RadiusSession } from '../../domain/entities/radiusSessions';
import { RadiusSessionRepository } from '../../domain/ports/RadiusSessionRepository';
import { PppoeServiceRepository, PppoeServiceWithClient } from '../../domain/ports/PppoeServiceRepository';

function makeRepo() {
  return new InMemoryRadiusSessionRepository();
}

/**
 * Stub de RadiusSessionRepository que devuelve exactamente las sesiones que le pasamos.
 * Nos deja controlar el `username` de cada sesión para probar el cruce a contrato.
 */
class StubRadiusSessionRepository implements RadiusSessionRepository {
  constructor(private readonly sessions: RadiusSession[]) {}
  async listSessions(): Promise<RadiusSession[]> {
    return [...this.sessions];
  }
  async disconnectSession(): Promise<{ success: boolean }> {
    return { success: true };
  }
}

function makeSession(overrides: Partial<RadiusSession>): RadiusSession {
  return {
    id: 'session-x',
    sessionId: 'ACCT0000000001',
    clientName: 'RADIUS Client',
    nasId: 'nas-1',
    nasName: 'NAS Central',
    ipAddress: '10.0.0.1',
    macAddress: 'AA:BB:CC:DD:EE:FF',
    startedAt: '2026-04-28T07:00:00Z',
    duration: 100,
    downloadBytes: 0,
    uploadBytes: 0,
    downloadMbps: 1,
    uploadMbps: 1,
    status: 'active',
    username: 'user1@ipnext.com.ar',
    contractId: null,
    clientId: null,
    customerName: null,
    ...overrides,
  };
}

describe('ListRadiusSessions', () => {
  it('returns 15 sessions', async () => {
    const repo = makeRepo();
    const uc = new ListRadiusSessions(repo, new InMemoryPppoeServiceRepository());

    const result = await uc.execute();

    expect(result).toHaveLength(15);
  });

  it('sessions have downloadMbps and duration fields', async () => {
    const repo = makeRepo();
    const uc = new ListRadiusSessions(repo, new InMemoryPppoeServiceRepository());

    const result = await uc.execute();

    expect(result[0]).toHaveProperty('downloadMbps');
    expect(result[0]).toHaveProperty('duration');
    expect(typeof result[0].downloadMbps).toBe('number');
    expect(typeof result[0].duration).toBe('number');
  });
});

describe('ListRadiusSessions — enriquecimiento con contrato (cruce por username)', () => {
  it('sesión cuyo PPPoE tiene contrato → trae contractId/clientId/customerName', async () => {
    const sessionRepo = new StubRadiusSessionRepository([
      makeSession({ id: 's1', username: 'juan@ipnext.com.ar' }),
    ]);
    const pppoeRepo = new InMemoryPppoeServiceRepository();
    await pppoeRepo.upsertByUsername({
      username: 'juan@ipnext.com.ar',
      password: 'secret',
      nasId: 'nas-1',
      contractId: 'contract-1',
    });
    pppoeRepo.setContractClient('contract-1', 'client-1', 'Juan Pérez');

    const uc = new ListRadiusSessions(sessionRepo, pppoeRepo);
    const result = await uc.execute();

    expect(result).toHaveLength(1);
    expect(result[0].contractId).toBe('contract-1');
    expect(result[0].clientId).toBe('client-1');
    expect(result[0].customerName).toBe('Juan Pérez');
  });

  it('sesión cuyo PPPoE es huérfano (contractId=null) → los 3 campos en null', async () => {
    const sessionRepo = new StubRadiusSessionRepository([
      makeSession({ id: 's2', username: 'orphan@ipnext.com.ar' }),
    ]);
    const pppoeRepo = new InMemoryPppoeServiceRepository();
    await pppoeRepo.upsertByUsername({
      username: 'orphan@ipnext.com.ar',
      password: 'secret',
      nasId: 'nas-1',
      contractId: null,
    });

    const uc = new ListRadiusSessions(sessionRepo, pppoeRepo);
    const result = await uc.execute();

    expect(result).toHaveLength(1);
    expect(result[0].contractId).toBeNull();
    expect(result[0].clientId).toBeNull();
    expect(result[0].customerName).toBeNull();
  });

  it('sesión SIN PppoeService matching → los 3 campos en null', async () => {
    const sessionRepo = new StubRadiusSessionRepository([
      makeSession({ id: 's3', username: 'ghost@ipnext.com.ar' }),
    ]);
    const pppoeRepo = new InMemoryPppoeServiceRepository();
    // No upsert: no hay PppoeService para 'ghost@ipnext.com.ar'.

    const uc = new ListRadiusSessions(sessionRepo, pppoeRepo);
    const result = await uc.execute();

    expect(result).toHaveLength(1);
    expect(result[0].contractId).toBeNull();
    expect(result[0].clientId).toBeNull();
    expect(result[0].customerName).toBeNull();
  });

  it('cruce BATCH (un solo findByUsernames con todos los usernames, NO N+1)', async () => {
    const sessions = [
      makeSession({ id: 's1', username: 'a@ipnext.com.ar' }),
      makeSession({ id: 's2', username: 'b@ipnext.com.ar' }),
      makeSession({ id: 's3', username: 'c@ipnext.com.ar' }),
    ];
    const sessionRepo = new StubRadiusSessionRepository(sessions);

    const realPppoe = new InMemoryPppoeServiceRepository();
    await realPppoe.upsertByUsername({ username: 'a@ipnext.com.ar', password: 'p', nasId: 'nas-1', contractId: 'c-a' });
    await realPppoe.upsertByUsername({ username: 'b@ipnext.com.ar', password: 'p', nasId: 'nas-1', contractId: 'c-b' });
    realPppoe.setContractClient('c-a', 'cli-a', 'Cliente A');
    realPppoe.setContractClient('c-b', 'cli-b', 'Cliente B');

    // Spy: contamos las llamadas a findByUsernames y verificamos que se llame UNA sola vez con TODOS los usernames.
    let callCount = 0;
    let receivedUsernames: string[] = [];
    const spyRepo: PppoeServiceRepository = {
      ...realPppoe,
      findByUsernames: async (usernames: string[]): Promise<PppoeServiceWithClient[]> => {
        callCount++;
        receivedUsernames = usernames;
        return realPppoe.findByUsernames(usernames);
      },
    } as unknown as PppoeServiceRepository;

    const uc = new ListRadiusSessions(sessionRepo, spyRepo);
    const result = await uc.execute();

    expect(callCount).toBe(1); // NO N+1: una sola query batch
    expect(receivedUsernames.sort()).toEqual(['a@ipnext.com.ar', 'b@ipnext.com.ar', 'c@ipnext.com.ar']);
    expect(result.find(s => s.id === 's1')?.contractId).toBe('c-a');
    expect(result.find(s => s.id === 's1')?.customerName).toBe('Cliente A');
    expect(result.find(s => s.id === 's2')?.contractId).toBe('c-b');
    expect(result.find(s => s.id === 's3')?.contractId).toBeNull(); // sin PppoeService
  });

  it('lista vacía de sesiones → NO consulta el repo de PPPoE (corto-circuito)', async () => {
    const sessionRepo = new StubRadiusSessionRepository([]);
    let callCount = 0;
    const realPppoe = new InMemoryPppoeServiceRepository();
    const spyRepo: PppoeServiceRepository = {
      ...realPppoe,
      findByUsernames: async (usernames: string[]): Promise<PppoeServiceWithClient[]> => {
        callCount++;
        return realPppoe.findByUsernames(usernames);
      },
    } as unknown as PppoeServiceRepository;

    const uc = new ListRadiusSessions(sessionRepo, spyRepo);
    const result = await uc.execute();

    expect(result).toHaveLength(0);
    expect(callCount).toBe(0);
  });
});

describe('DisconnectSession', () => {
  it('returns { success: true } when session exists', async () => {
    const repo = makeRepo();
    const uc = new DisconnectSession(repo);

    const result = await uc.execute('session-1');

    expect(result.success).toBe(true);
  });
});
