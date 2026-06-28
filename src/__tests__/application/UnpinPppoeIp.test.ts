/**
 * UnpinPppoeIp use case — TDD tests (pppoe-pool-ip Fase 1 BE, Decisión 5).
 *
 * Scenarios:
 *   - unpin exitoso: changeFramedIp(null) + setIpMode('pool', null) persisted
 *   - NAS sin poolName (no pool-mode): NasNoPoolError (no hay pool al que volver)
 *   - PPPoE no encontrado: PppoeServiceNotFoundError
 *   - NAS no encontrado: NasNotFoundError
 *   - control-plane first: si changeFramedIp falla, la DB no se actualiza
 */
import { UnpinPppoeIp } from '@application/use-cases/UnpinPppoeIp';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import {
  PppoeServiceNotFoundError,
  NasNotFoundError,
  NasNoPoolError,
} from '@domain/errors/pppoe';

const NAS_POOL_ID = '3'; // radius_orchestrator + poolName seteado (seed)
const NAS_MK_ID   = '1'; // mikrotik_api — sin poolName (no pool-mode)

describe('UnpinPppoeIp', () => {
  let pppoeRepo: InMemoryPppoeServiceRepository;
  let nasRepo: InMemoryNasRepository;
  let orchestrator: InMemoryRadiusOrchestratorGateway;
  let uc: UnpinPppoeIp;

  const seedPinnedPppoe = async (nasId = NAS_POOL_ID) => {
    return pppoeRepo.upsertByUsername({
      username: 'testuser',
      password: 'pass',
      nasId,
      status: 'enabled',
      remoteAddress: '100.64.10.10',
      ipMode: 'fixed',
    });
  };

  beforeEach(() => {
    pppoeRepo    = new InMemoryPppoeServiceRepository();
    nasRepo      = new InMemoryNasRepository();
    orchestrator = new InMemoryRadiusOrchestratorGateway();
    uc = new UnpinPppoeIp(pppoeRepo, nasRepo, orchestrator);
  });

  it('unpin exitoso: llama changeFramedIp(null) y persiste ipMode=pool + remoteAddress=null', async () => {
    const svc = await seedPinnedPppoe();
    const result = await uc.execute({ pppoeId: svc.id });
    expect(result.ipMode).toBe('pool');
    expect(result.remoteAddress).toBeNull();
    const call = orchestrator.calls.find(c => c.op === 'changeFramedIp' && c.username === 'testuser');
    expect(call).toBeDefined();
    expect((call!.arg as { framedIp: null }).framedIp).toBeNull();
  });

  it('NAS sin poolName (no pool-mode): NasNoPoolError', async () => {
    const svc = await seedPinnedPppoe(NAS_MK_ID);
    await expect(uc.execute({ pppoeId: svc.id })).rejects.toBeInstanceOf(NasNoPoolError);
    expect(orchestrator.calls).toHaveLength(0);
  });

  it('PPPoE no encontrado: PppoeServiceNotFoundError', async () => {
    await expect(uc.execute({ pppoeId: 'nonexistent' })).rejects.toBeInstanceOf(PppoeServiceNotFoundError);
  });

  it('NAS no encontrado: NasNotFoundError', async () => {
    const svc = await pppoeRepo.upsertByUsername({
      username: 'orphan', password: 'p', nasId: 'ghost-nas', status: 'enabled',
    });
    await expect(uc.execute({ pppoeId: svc.id })).rejects.toBeInstanceOf(NasNotFoundError);
  });

  it('control-plane first: si changeFramedIp falla, la DB no se actualiza', async () => {
    const svc = await seedPinnedPppoe();
    orchestrator = new InMemoryRadiusOrchestratorGateway({ unreachable: ['testuser'] });
    uc = new UnpinPppoeIp(pppoeRepo, nasRepo, orchestrator);
    await expect(uc.execute({ pppoeId: svc.id })).rejects.toThrow();
    const row = await pppoeRepo.findById(svc.id);
    expect(row!.ipMode).toBe('fixed');
    expect(row!.remoteAddress).toBe('100.64.10.10');
  });
});
