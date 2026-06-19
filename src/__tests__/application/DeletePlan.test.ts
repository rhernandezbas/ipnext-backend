import { DeletePlan } from '@application/use-cases/DeletePlan';
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { PlanNotFoundError } from '@domain/errors/plan';

function makeGateway(opts?: { failForCode?: string }) {
  return new InMemoryRadiusOrchestratorGateway({ failForPlanCode: opts?.failForCode ? [opts.failForCode] : [] });
}

describe('DeletePlan', () => {
  it('deletes an existing plan', async () => {
    const repo = new InMemoryPlanRepository();
    const created = await repo.upsertByCode({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    const gw = makeGateway();
    const uc = new DeletePlan(repo, gw);
    await uc.execute(created.id);
    expect(await repo.findById(created.id)).toBeNull();
  });

  it('throws PlanNotFoundError for unknown id', async () => {
    const repo = new InMemoryPlanRepository();
    const gw = makeGateway();
    const uc = new DeletePlan(repo, gw);
    await expect(uc.execute('nonexistent')).rejects.toThrow(PlanNotFoundError);
  });

  it('calls deletePlan on the orchestrator with the plan code', async () => {
    const repo = new InMemoryPlanRepository();
    const created = await repo.upsertByCode({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    const gw = makeGateway();
    const uc = new DeletePlan(repo, gw);
    await uc.execute(created.id);
    const del = gw.planCalls.find(c => c.op === 'deletePlan' && c.code === 'IP-Air-30-10');
    expect(del).toBeDefined();
  });

  it('does NOT delete from DB if the orchestrator fails', async () => {
    const repo = new InMemoryPlanRepository();
    const created = await repo.upsertByCode({ code: 'IP-Fail-10-5', name: 'Fail Plan', category: 'Air', downloadKbps: 10000, uploadKbps: 5000 });
    const gw = makeGateway({ failForCode: 'IP-Fail-10-5' });
    const uc = new DeletePlan(repo, gw);
    await expect(uc.execute(created.id)).rejects.toThrow();
    // Sigue en la DB
    expect(await repo.findById(created.id)).not.toBeNull();
  });
});
