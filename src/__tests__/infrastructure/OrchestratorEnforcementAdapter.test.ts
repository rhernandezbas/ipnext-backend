import { OrchestratorEnforcementAdapter } from '@infrastructure/adapters/orchestrator/OrchestratorEnforcementAdapter';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { PppoeService } from '@domain/entities/pppoeService';
import { NasServer } from '@domain/entities/nas';
import { OrchestratorUnreachableError } from '@domain/errors/pppoe';

const REDUCED = 'IP-REDUCCION';
const COMMERCIAL = 'IP-Air-30-10';
const USER = 'MarianoCabreraMerc';

const nas: NasServer = {
  id: '6', name: 'AccesoSur', type: 'radius_orchestrator', ipAddress: '10.60.0.38',
  radiusSecret: '', nasIpAddress: '', apiPort: 8728, apiLogin: null, apiPassword: null,
  status: 'active', lastSeen: null, clientCount: 0, description: '',
};

function pppoe(over: Partial<PppoeService> = {}): PppoeService {
  return {
    id: 'p1', username: USER, password: 'pw', profile: COMMERCIAL,
    remoteAddress: '100.64.10.10', status: 'enabled', nasId: '6', contractId: 'c1',
    enforcedState: 'active', callerId: null, createdAt: '2026-01-01', ...over,
  };
}

function setup(opts?: { unreachable?: string[] }) {
  const orch = new InMemoryRadiusOrchestratorGateway({
    unreachable: opts?.unreachable ?? [],
    seed: [{ username: USER, plan: COMMERCIAL }],
  });
  const adapter = new OrchestratorEnforcementAdapter(orch, REDUCED);
  return { orch, adapter };
}

describe('OrchestratorEnforcementAdapter (Inc3 — corte vía RADIUS/orchestrator)', () => {
  it('reduce: changePlan al plan reducido aplicado en sesión (CoA)', async () => {
    const { orch, adapter } = setup();
    await adapter.apply(pppoe(), nas, 'reduce');
    expect(orch.planOf(USER)).toBe(REDUCED);
    expect(orch.calls).toContainEqual({ op: 'changePlan', username: USER, arg: { plan: REDUCED, applyInSession: true } });
  });

  it('block: suspend con desconexión de la sesión viva', async () => {
    const { orch, adapter } = setup();
    await adapter.apply(pppoe(), nas, 'block');
    expect(orch.isSuspended(USER)).toBe(true);
    expect(orch.calls).toContainEqual({ op: 'suspend', username: USER, arg: { disconnectActiveSessions: true } });
  });

  it('restore desde blocked: reactivate', async () => {
    const { orch, adapter } = setup();
    await orch.suspend(USER, { disconnectActiveSessions: true }); // estaba bloqueado
    await adapter.apply(pppoe({ enforcedState: 'blocked' }), nas, 'restore');
    expect(orch.isSuspended(USER)).toBe(false);
    expect(orch.opsFor(USER)).toContain('reactivate');
  });

  it('restore desde reduced: changePlan de vuelta al comercial', async () => {
    const { orch, adapter } = setup();
    await orch.changePlan(USER, REDUCED); // estaba reducido
    await adapter.apply(pppoe({ enforcedState: 'reduced' }), nas, 'restore');
    expect(orch.planOf(USER)).toBe(COMMERCIAL);
  });

  it('restore RESPETA la baja comercial: status=disabled → suspend (NO reactiva)', async () => {
    const { orch, adapter } = setup();
    await adapter.apply(pppoe({ enforcedState: 'blocked', status: 'disabled' }), nas, 'restore');
    expect(orch.isSuspended(USER)).toBe(true);
    expect(orch.opsFor(USER)).not.toContain('reactivate');
  });

  it('restore desde reduced con profile comercial null: no manda changePlan vacío', async () => {
    const { orch, adapter } = setup();
    await orch.changePlan(USER, REDUCED);
    await adapter.apply(pppoe({ enforcedState: 'reduced', profile: null }), nas, 'restore');
    // sin profile comercial → no se intenta cambiar a '' (queda como lo dejó el orchestrator)
    expect(orch.calls.filter((c) => c.op === 'changePlan' && c.username === USER)).toHaveLength(1);
  });

  it('orchestrator caído: propaga OrchestratorUnreachableError (el use case NO confirma en DB)', async () => {
    const { adapter } = setup({ unreachable: [USER] });
    await expect(adapter.apply(pppoe(), nas, 'reduce')).rejects.toBeInstanceOf(OrchestratorUnreachableError);
  });
});
