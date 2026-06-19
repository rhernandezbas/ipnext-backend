import { CreatePlan } from '@application/use-cases/CreatePlan';
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { PlanCodeTakenError } from '@domain/errors/plan';

function makeGateway(opts?: { failForCode?: string }) {
  return new InMemoryRadiusOrchestratorGateway({ failForPlanCode: opts?.failForCode ? [opts.failForCode] : [] });
}

describe('CreatePlan', () => {
  it('creates a plan and returns it', async () => {
    const repo = new InMemoryPlanRepository();
    const gw = makeGateway();
    const uc = new CreatePlan(repo, gw);
    const plan = await uc.execute({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    expect(plan.id).toBeDefined();
    expect(plan.code).toBe('IP-Air-30-10');
    expect(plan.status).toBe('enabled');
  });

  it('throws PlanCodeTakenError if code already exists', async () => {
    const repo = new InMemoryPlanRepository();
    await repo.upsertByCode({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    const gw = makeGateway();
    const uc = new CreatePlan(repo, gw);
    await expect(uc.execute({ code: 'IP-Air-30-10', name: 'Another', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 }))
      .rejects.toThrow(PlanCodeTakenError);
  });

  it('calls syncPlan on the orchestrator with correct args before persisting', async () => {
    const repo = new InMemoryPlanRepository();
    const gw = makeGateway();
    const uc = new CreatePlan(repo, gw);
    await uc.execute({ code: 'IP-Fiber-100-50', name: 'Fiber 100/50', category: 'Fiber', downloadKbps: 100000, uploadKbps: 50000 });
    const sync = gw.planCalls.find(c => c.op === 'syncPlan' && c.code === 'IP-Fiber-100-50');
    expect(sync).toBeDefined();
    expect(sync?.downloadKbps).toBe(100000);
    expect(sync?.uploadKbps).toBe(50000);
    expect(sync?.pool).toBeNull(); // null cuando no se pasa pool (orchestrator-first: se envía explícitamente)
  });

  it('does NOT persist the plan if the orchestrator fails', async () => {
    const repo = new InMemoryPlanRepository();
    const gw = makeGateway({ failForCode: 'IP-Fail-10-5' });
    const uc = new CreatePlan(repo, gw);
    await expect(uc.execute({ code: 'IP-Fail-10-5', name: 'Fail Plan', category: 'Air', downloadKbps: 10000, uploadKbps: 5000 }))
      .rejects.toThrow();
    // La fila NO debe existir en la DB si el orchestrator falló
    expect(await repo.findByCode('IP-Fail-10-5')).toBeNull();
  });

  it('calls syncPlan BEFORE creating the DB row (orchestrator-first)', async () => {
    const repo = new InMemoryPlanRepository();
    const callOrder: string[] = [];
    const gw = new InMemoryRadiusOrchestratorGateway({ onSyncPlan: () => callOrder.push('orchestrator') });
    const originalUpsert = repo.upsertByCode.bind(repo);
    repo.upsertByCode = async (...args) => { callOrder.push('db'); return originalUpsert(...args); };
    const uc = new CreatePlan(repo, gw);
    await uc.execute({ code: 'IP-Order-Test', name: 'Order Test', category: 'Air', downloadKbps: 10000, uploadKbps: 5000 });
    expect(callOrder).toEqual(['orchestrator', 'db']);
  });
});
