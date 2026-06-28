/**
 * PinPppoeIp use case — TDD tests (pppoe-pool-ip Fase 1 BE, Decisión 5).
 *
 * Scenarios:
 *   - pin exitoso: changeFramedIp + setIpMode(fixed, ip) persisted
 *   - IP inválida (formato): InvalidIpFormatError (sin tocar el orchestrator)
 *   - IP ya tomada por OTRO usuario: IpAlreadyTakenError (sin tocar el orchestrator)
 *   - PPPoE no encontrado: PppoeServiceNotFoundError
 *   - NAS no encontrado: NasNotFoundError
 *   - NAS no rutea via orchestrator: error (pin no soportado)
 *   - control-plane first: si changeFramedIp falla, la DB no se toca
 */
import { PinPppoeIp } from '@application/use-cases/PinPppoeIp';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import {
  PppoeServiceNotFoundError,
  NasNotFoundError,
  InvalidIpFormatError,
  IpAlreadyTakenError,
} from '@domain/errors/pppoe';

const NAS_POOL_ID = '3'; // radius_orchestrator + poolName seteado (seed)
const NAS_MK_ID   = '1'; // mikrotik_api — NO rutea via orchestrator

describe('PinPppoeIp', () => {
  let pppoeRepo: InMemoryPppoeServiceRepository;
  let nasRepo: InMemoryNasRepository;
  let orchestrator: InMemoryRadiusOrchestratorGateway;
  let uc: PinPppoeIp;

  const seedPppoe = async (overrides: Partial<Parameters<typeof pppoeRepo.upsertByUsername>[0]> = {}) => {
    return pppoeRepo.upsertByUsername({
      username: 'testuser',
      password: 'pass',
      nasId: NAS_POOL_ID,
      status: 'enabled',
      ipMode: 'pool',
      ...overrides,
    });
  };

  beforeEach(() => {
    pppoeRepo = new InMemoryPppoeServiceRepository();
    nasRepo   = new InMemoryNasRepository();
    orchestrator = new InMemoryRadiusOrchestratorGateway();
    uc = new PinPppoeIp(pppoeRepo, nasRepo, orchestrator);
  });

  it('pin exitoso: llama changeFramedIp y persiste ipMode=fixed + remoteAddress', async () => {
    const svc = await seedPppoe();
    const result = await uc.execute({ pppoeId: svc.id, ip: '100.64.10.10' });
    expect(result.ipMode).toBe('fixed');
    expect(result.remoteAddress).toBe('100.64.10.10');
    const call = orchestrator.calls.find(c => c.op === 'changeFramedIp' && c.username === 'testuser');
    expect(call).toBeDefined();
    expect((call!.arg as { framedIp: string }).framedIp).toBe('100.64.10.10');
  });

  it('IP inválida: InvalidIpFormatError (sin tocar el orchestrator)', async () => {
    const svc = await seedPppoe();
    await expect(uc.execute({ pppoeId: svc.id, ip: 'not-an-ip' }))
      .rejects.toBeInstanceOf(InvalidIpFormatError);
    expect(orchestrator.calls).toHaveLength(0);
  });

  it('IP con octetos fuera de rango: InvalidIpFormatError', async () => {
    const svc = await seedPppoe();
    await expect(uc.execute({ pppoeId: svc.id, ip: '300.1.2.3' }))
      .rejects.toBeInstanceOf(InvalidIpFormatError);
  });

  it('IP ya asignada a OTRO usuario: IpAlreadyTakenError', async () => {
    const svc = await seedPppoe();
    orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIps: ['100.64.10.10'] });
    uc = new PinPppoeIp(pppoeRepo, nasRepo, orchestrator);
    await expect(uc.execute({ pppoeId: svc.id, ip: '100.64.10.10' }))
      .rejects.toBeInstanceOf(IpAlreadyTakenError);
    expect(orchestrator.calls.filter(c => c.op === 'changeFramedIp')).toHaveLength(0);
  });

  it('re-pin a la MISMA IP del propio servicio (ya en listAssignedIps): NO tira IpAlreadyTakenError', async () => {
    // El servicio ya está pineado a 100.64.10.10 → su IP aparece en listAssignedIps. Re-pinearlo
    // a su MISMA IP NO es un conflicto: hay que excluir la IP propia del set de "tomadas".
    const svc = await seedPppoe({ ipMode: 'fixed', remoteAddress: '100.64.10.10' });
    orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIps: ['100.64.10.10'] });
    uc = new PinPppoeIp(pppoeRepo, nasRepo, orchestrator);

    const result = await uc.execute({ pppoeId: svc.id, ip: '100.64.10.10' });
    expect(result.ipMode).toBe('fixed');
    expect(result.remoteAddress).toBe('100.64.10.10');
    const call = orchestrator.calls.find(c => c.op === 'changeFramedIp' && c.username === 'testuser');
    expect(call).toBeDefined();
  });

  it('pin a la IP de OTRO usuario sí tira IpAlreadyTakenError (aunque el servicio tenga IP propia)', async () => {
    // El servicio tiene su propia IP (100.64.10.10), pero quiere pinear 100.64.10.20 que es de otro.
    const svc = await seedPppoe({ ipMode: 'fixed', remoteAddress: '100.64.10.10' });
    orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIps: ['100.64.10.10', '100.64.10.20'] });
    uc = new PinPppoeIp(pppoeRepo, nasRepo, orchestrator);

    await expect(uc.execute({ pppoeId: svc.id, ip: '100.64.10.20' }))
      .rejects.toBeInstanceOf(IpAlreadyTakenError);
    expect(orchestrator.calls.filter(c => c.op === 'changeFramedIp')).toHaveLength(0);
  });

  it('PPPoE no encontrado: PppoeServiceNotFoundError', async () => {
    await expect(uc.execute({ pppoeId: 'nonexistent', ip: '100.64.10.10' }))
      .rejects.toBeInstanceOf(PppoeServiceNotFoundError);
  });

  it('NAS no encontrado: NasNotFoundError', async () => {
    const svc = await pppoeRepo.upsertByUsername({
      username: 'orphan', password: 'p', nasId: 'ghost-nas', status: 'enabled',
    });
    await expect(uc.execute({ pppoeId: svc.id, ip: '100.64.10.10' }))
      .rejects.toBeInstanceOf(NasNotFoundError);
  });

  it('NAS no rutea via orchestrator: rechaza (pin no soportado)', async () => {
    const svc = await pppoeRepo.upsertByUsername({
      username: 'mkuser', password: 'p', nasId: NAS_MK_ID, status: 'enabled',
    });
    await expect(uc.execute({ pppoeId: svc.id, ip: '192.168.1.10' }))
      .rejects.toThrow();
  });

  it('control-plane first: si changeFramedIp falla, NO persiste en DB', async () => {
    const svc = await seedPppoe();
    orchestrator = new InMemoryRadiusOrchestratorGateway({ unreachable: ['testuser'] });
    uc = new PinPppoeIp(pppoeRepo, nasRepo, orchestrator);
    await expect(uc.execute({ pppoeId: svc.id, ip: '100.64.10.10' })).rejects.toThrow();
    const row = await pppoeRepo.findById(svc.id);
    expect(row!.ipMode).toBe('pool');
    expect(row!.remoteAddress).toBeNull();
  });
});
