/**
 * SetNasPoolMode use case — TDD tests (pppoe-pool-ip Fase 1 BE, Decisión 3).
 *
 * Marca un NAS en modo pool asignándole un `poolName`. PRE-CHECK: consulta el
 * `radippool` vía el orchestrator (GET /pools) y RECHAZA si el pool está vacío
 * (sin IPs libres) → evita "NAS en pool sin pool poblado → cliente sin IP".
 *
 * Consistencia: el plano de control (orchestrator) va ANTES de tocar la DB.
 * Si el orchestrator falla, la fila del NAS NO se modifica.
 *
 * Scenarios:
 *   - pool poblado (free>0)         → persiste poolName
 *   - pool vacío (free=0)           → RadiusPoolEmptyError, DB sin tocar
 *   - pool inexistente en radippool → RadiusPoolEmptyError
 *   - NAS inexistente               → NasNotFoundError (sin consultar pools)
 *   - orchestrator caído            → OrchestratorUnreachableError, DB sin tocar
 *   - poolName=null (desactiva)     → persiste null sin pre-check
 */
import { SetNasPoolMode } from '@application/use-cases/SetNasPoolMode';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import {
  NasNotFoundError,
  RadiusPoolEmptyError,
  OrchestratorUnreachableError,
} from '@domain/errors/pppoe';

const NAS_TARGET = '1'; // sin poolName en el seed in-memory

describe('SetNasPoolMode', () => {
  let nasRepo: InMemoryNasRepository;
  let orchestrator: InMemoryRadiusOrchestratorGateway;
  let uc: SetNasPoolMode;

  beforeEach(() => {
    nasRepo = new InMemoryNasRepository();
  });

  it('pool poblado (free>0): persiste poolName y lo devuelve', async () => {
    orchestrator = new InMemoryRadiusOrchestratorGateway({ pools: [{ name: 'asur-cgnat', total: 200, free: 50 }] });
    uc = new SetNasPoolMode(nasRepo, orchestrator);

    const nas = await uc.execute({ nasId: NAS_TARGET, poolName: 'asur-cgnat' });

    expect(nas.poolName).toBe('asur-cgnat');
    const reread = await nasRepo.findNasServerById(NAS_TARGET);
    expect(reread!.poolName).toBe('asur-cgnat');
  });

  it('pool vacío (free=0): RadiusPoolEmptyError y la DB no se toca', async () => {
    orchestrator = new InMemoryRadiusOrchestratorGateway({ pools: [{ name: 'asur-cgnat', total: 200, free: 0 }] });
    uc = new SetNasPoolMode(nasRepo, orchestrator);

    await expect(uc.execute({ nasId: NAS_TARGET, poolName: 'asur-cgnat' }))
      .rejects.toBeInstanceOf(RadiusPoolEmptyError);

    const reread = await nasRepo.findNasServerById(NAS_TARGET);
    expect(reread!.poolName == null).toBe(true);
  });

  it('pool con free NO finito (shape inesperado del GET /pools): RadiusPoolEmptyError (fail-closed)', async () => {
    // `NaN <= 0` es false → sin el guard de Number.isFinite un `free` corrupto pasaría como
    // falso-OK y dejaría las altas nuevas sin IP. El pre-check debe RECHAZAR y NO tocar la DB.
    orchestrator = new InMemoryRadiusOrchestratorGateway({ pools: [{ name: 'asur-cgnat', total: 200, free: NaN }] });
    uc = new SetNasPoolMode(nasRepo, orchestrator);

    await expect(uc.execute({ nasId: NAS_TARGET, poolName: 'asur-cgnat' }))
      .rejects.toBeInstanceOf(RadiusPoolEmptyError);

    const reread = await nasRepo.findNasServerById(NAS_TARGET);
    expect(reread!.poolName == null).toBe(true);
  });

  it('pool inexistente en radippool: RadiusPoolEmptyError', async () => {
    orchestrator = new InMemoryRadiusOrchestratorGateway({ pools: [] });
    uc = new SetNasPoolMode(nasRepo, orchestrator);

    await expect(uc.execute({ nasId: NAS_TARGET, poolName: 'no-existe' }))
      .rejects.toBeInstanceOf(RadiusPoolEmptyError);
  });

  it('NAS inexistente: NasNotFoundError', async () => {
    orchestrator = new InMemoryRadiusOrchestratorGateway({ pools: [{ name: 'asur-cgnat', total: 1, free: 1 }] });
    uc = new SetNasPoolMode(nasRepo, orchestrator);

    await expect(uc.execute({ nasId: 'ghost', poolName: 'asur-cgnat' }))
      .rejects.toBeInstanceOf(NasNotFoundError);
  });

  it('orchestrator caído en el pre-check: OrchestratorUnreachableError y la DB no se toca', async () => {
    orchestrator = new InMemoryRadiusOrchestratorGateway({ poolsUnreachable: true });
    uc = new SetNasPoolMode(nasRepo, orchestrator);

    await expect(uc.execute({ nasId: NAS_TARGET, poolName: 'asur-cgnat' }))
      .rejects.toBeInstanceOf(OrchestratorUnreachableError);

    const reread = await nasRepo.findNasServerById(NAS_TARGET);
    expect(reread!.poolName == null).toBe(true);
  });

  it('poolName=null (desactiva pool-mode): persiste null SIN pre-check del orchestrator', async () => {
    // NAS '3' arranca con poolName en el seed; el orchestrator está caído → si se consultara, fallaría.
    orchestrator = new InMemoryRadiusOrchestratorGateway({ poolsUnreachable: true });
    uc = new SetNasPoolMode(nasRepo, orchestrator);

    const nas = await uc.execute({ nasId: '3', poolName: null });

    expect(nas.poolName == null).toBe(true);
  });
});
