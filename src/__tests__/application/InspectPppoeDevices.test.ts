/**
 * InspectPppoeDevices.test.ts — TDD Strict
 *
 * Cubre:
 *   1. Happy path: airos retorna model+ownMac+lanMacs → antenna+router con brand
 *   2. AirOsUnreachableError → antenna desde caller-id, router null, warning (best-effort, sin throw)
 *   3. Sin PPPoE activo en el contrato → warnings
 *   4. PPPoE sin remoteAddress → warning; antenna desde caller-id
 *   5. ARP vacío (lanMacs=[]) → router null + warning
 *   6. Router MAC con OUI desconocido → brand null
 */
import { InspectPppoeDevices } from '@application/use-cases/InspectPppoeDevices';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryAirOsGateway } from '@infrastructure/adapters/in-memory/InMemoryAirOsGateway';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { AirOsUnreachableError } from '@domain/errors/airos';
import type { OrchestratorSession } from '@domain/ports/RadiusOrchestratorGateway';

function makeSession(username: string, callerId: string | null = 'AA:BB:CC:11:22:33'): OrchestratorSession {
  return {
    sessionId: 'sess-1',
    username,
    nasIp: '10.0.0.1',
    framedIp: '100.64.10.173',
    startedAt: new Date().toISOString(),
    bytesIn: 0,
    bytesOut: 0,
    callerId,
  };
}

describe('InspectPppoeDevices', () => {
  const CONTRACT_ID = 'contract-abc';
  const PPP_USERNAME = 'cliente01';
  const ANTENNA_IP = '100.64.10.173';

  async function buildRepoWithPppoe(opts: {
    remoteAddress?: string | null;
    status?: string;
  } = {}) {
    const pppoeRepo = new InMemoryPppoeServiceRepository();
    await pppoeRepo.upsertByUsername({
      username: PPP_USERNAME,
      password: 'pass',
      nasId: 'nas-1',
      contractId: CONTRACT_ID,
      status: opts.status ?? 'enabled',
      remoteAddress: opts.remoteAddress !== undefined ? opts.remoteAddress : ANTENNA_IP,
    });
    return pppoeRepo;
  }

  it('happy path: airos retorna model+ownMac+lanMacs → antenna y router con brand', async () => {
    const pppoeRepo = await buildRepoWithPppoe();
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      seed: [{ username: PPP_USERNAME, sessions: [makeSession(PPP_USERNAME)] }],
    });
    const airos = new InMemoryAirOsGateway({
      result: {
        model: 'LiteBeam 5AC Gen2',
        ownMac: '78:8A:20:96:6A:AE',
        lanMacs: ['c0:c9:e3:34:33:75'],
      },
    });

    const uc = new InspectPppoeDevices(pppoeRepo, orchestrator, airos);
    const result = await uc.execute(CONTRACT_ID);

    expect(result.antenna.model).toBe('LiteBeam 5AC Gen2');
    expect(result.antenna.mac).toBe('78:8A:20:96:6A:AE');
    expect(result.router?.mac).toBe('c0:c9:e3:34:33:75');
    expect(result.router?.brand).toBe('TP-Link');
    expect(result.warnings).toEqual([]);
  });

  it('AirOsUnreachableError → antenna usa caller-id, router null, warning best-effort', async () => {
    const pppoeRepo = await buildRepoWithPppoe();
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      seed: [{ username: PPP_USERNAME, sessions: [makeSession(PPP_USERNAME, 'AA:BB:CC:11:22:33')] }],
    });
    const airos = new InMemoryAirOsGateway({
      throws: new AirOsUnreachableError(ANTENNA_IP),
    });

    const uc = new InspectPppoeDevices(pppoeRepo, orchestrator, airos);
    const result = await uc.execute(CONTRACT_ID);

    // NO lanza — best-effort
    expect(result.antenna.mac).toBe('AA:BB:CC:11:22:33');
    expect(result.antenna.model).toBeNull();
    expect(result.router).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/SSH|offline|caller-id/i);
  });

  it('sin PPPoE activo en el contrato → warning sin resultados', async () => {
    const pppoeRepo = new InMemoryPppoeServiceRepository();
    const orchestrator = new InMemoryRadiusOrchestratorGateway();
    const airos = new InMemoryAirOsGateway({ result: { model: null, ownMac: null, lanMacs: [] } });

    const uc = new InspectPppoeDevices(pppoeRepo, orchestrator, airos);
    const result = await uc.execute(CONTRACT_ID);

    expect(result.antenna.mac).toBeNull();
    expect(result.antenna.model).toBeNull();
    expect(result.router).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/PPPoE|activo|contrato/i);
  });

  it('PPPoE sin remoteAddress → warning; antenna usa caller-id', async () => {
    const pppoeRepo = await buildRepoWithPppoe({ remoteAddress: null });
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      seed: [{ username: PPP_USERNAME, sessions: [makeSession(PPP_USERNAME, 'DD:EE:FF:00:11:22')] }],
    });
    const airos = new InMemoryAirOsGateway({ result: { model: null, ownMac: null, lanMacs: [] } });

    const uc = new InspectPppoeDevices(pppoeRepo, orchestrator, airos);
    const result = await uc.execute(CONTRACT_ID);

    expect(result.antenna.mac).toBe('DD:EE:FF:00:11:22');
    expect(result.antenna.model).toBeNull();
    expect(result.router).toBeNull();
    expect(result.warnings.some(w => /IP|remoteAddress|asignada/i.test(w))).toBe(true);
  });

  it('ARP vacío (lanMacs=[]) → router null + warning', async () => {
    const pppoeRepo = await buildRepoWithPppoe();
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      seed: [{ username: PPP_USERNAME, sessions: [makeSession(PPP_USERNAME)] }],
    });
    const airos = new InMemoryAirOsGateway({
      result: { model: 'LiteBeam 5AC Gen2', ownMac: '78:8A:20:96:6A:AE', lanMacs: [] },
    });

    const uc = new InspectPppoeDevices(pppoeRepo, orchestrator, airos);
    const result = await uc.execute(CONTRACT_ID);

    expect(result.router).toBeNull();
    expect(result.warnings.some(w => /router|ARP|encontr/i.test(w))).toBe(true);
  });

  it('router MAC con OUI desconocido → brand null', async () => {
    const pppoeRepo = await buildRepoWithPppoe();
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      seed: [{ username: PPP_USERNAME, sessions: [makeSession(PPP_USERNAME)] }],
    });
    const airos = new InMemoryAirOsGateway({
      result: {
        model: 'LiteBeam 5AC Gen2',
        ownMac: '78:8A:20:96:6A:AE',
        lanMacs: ['00:00:00:01:02:03'], // OUI desconocido
      },
    });

    const uc = new InspectPppoeDevices(pppoeRepo, orchestrator, airos);
    const result = await uc.execute(CONTRACT_ID);

    expect(result.router?.mac).toBe('00:00:00:01:02:03');
    expect(result.router?.brand).toBeNull();
  });

  it('router.model viene del DHCP lease de la antena (cruce por MAC)', async () => {
    const pppoeRepo = await buildRepoWithPppoe();
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      seed: [{ username: PPP_USERNAME, sessions: [makeSession(PPP_USERNAME)] }],
    });
    const airos = new InMemoryAirOsGateway({
      result: {
        model: 'LiteBeam 5AC Gen2',
        ownMac: '78:8A:20:96:6A:AE',
        lanMacs: ['c0:c9:e3:34:33:75'],
        leases: { 'c0:c9:e3:34:33:75': 'TL-WR820N' },
      },
    });

    const uc = new InspectPppoeDevices(pppoeRepo, orchestrator, airos);
    const result = await uc.execute(CONTRACT_ID);

    expect(result.router?.mac).toBe('c0:c9:e3:34:33:75');
    expect(result.router?.model).toBe('TL-WR820N');
  });

  it('router.model null si no hay lease para esa MAC (best-effort)', async () => {
    const pppoeRepo = await buildRepoWithPppoe();
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      seed: [{ username: PPP_USERNAME, sessions: [makeSession(PPP_USERNAME)] }],
    });
    const airos = new InMemoryAirOsGateway({
      result: {
        model: 'LiteBeam 5AC Gen2',
        ownMac: '78:8A:20:96:6A:AE',
        lanMacs: ['c0:c9:e3:34:33:75'],
        leases: {},
      },
    });

    const uc = new InspectPppoeDevices(pppoeRepo, orchestrator, airos);
    const result = await uc.execute(CONTRACT_ID);

    expect(result.router?.mac).toBe('c0:c9:e3:34:33:75');
    expect(result.router?.model).toBeNull();
  });
});
