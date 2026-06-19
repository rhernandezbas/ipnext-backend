import { UpdatePlan } from '@application/use-cases/UpdatePlan';
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { PlanNotFoundError } from '@domain/errors/plan';

function makeGateway(opts?: { failForCode?: string }) {
  return new InMemoryRadiusOrchestratorGateway({ failForPlanCode: opts?.failForCode ? [opts.failForCode] : [] });
}

describe('UpdatePlan', () => {
  it('updates a plan name', async () => {
    const repo = new InMemoryPlanRepository();
    const created = await repo.upsertByCode({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    const gw = makeGateway();
    const uc = new UpdatePlan(repo, gw);
    const updated = await uc.execute({ id: created.id, name: 'Air 30/10 Updated' });
    expect(updated.name).toBe('Air 30/10 Updated');
    expect(updated.code).toBe('IP-Air-30-10'); // code no cambia
  });

  it('throws PlanNotFoundError for unknown id', async () => {
    const repo = new InMemoryPlanRepository();
    const gw = makeGateway();
    const uc = new UpdatePlan(repo, gw);
    await expect(uc.execute({ id: 'nonexistent', name: 'X' })).rejects.toThrow(PlanNotFoundError);
  });

  it('calls syncPlan on the orchestrator with the merged kbps values', async () => {
    const repo = new InMemoryPlanRepository();
    const created = await repo.upsertByCode({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    const gw = makeGateway();
    const uc = new UpdatePlan(repo, gw);
    await uc.execute({ id: created.id, downloadKbps: 50000, uploadKbps: 20000 });
    const sync = gw.planCalls.find(c => c.op === 'syncPlan' && c.code === 'IP-Air-30-10');
    expect(sync).toBeDefined();
    expect(sync?.downloadKbps).toBe(50000);
    expect(sync?.uploadKbps).toBe(20000);
  });

  it('does NOT update the DB if the orchestrator fails', async () => {
    const repo = new InMemoryPlanRepository();
    const created = await repo.upsertByCode({ code: 'IP-Fail-10-5', name: 'Fail Plan', category: 'Air', downloadKbps: 10000, uploadKbps: 5000 });
    const gw = makeGateway({ failForCode: 'IP-Fail-10-5' });
    const uc = new UpdatePlan(repo, gw);
    await expect(uc.execute({ id: created.id, downloadKbps: 99999 })).rejects.toThrow();
    // El valor en DB debe ser el original
    const inDb = await repo.findById(created.id);
    expect(inDb?.downloadKbps).toBe(10000);
  });

  it('calls syncPlan with existing kbps when only name changes', async () => {
    const repo = new InMemoryPlanRepository();
    const created = await repo.upsertByCode({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    const gw = makeGateway();
    const uc = new UpdatePlan(repo, gw);
    await uc.execute({ id: created.id, name: 'Air 30/10 Renamed' });
    const sync = gw.planCalls.find(c => c.op === 'syncPlan' && c.code === 'IP-Air-30-10');
    expect(sync?.downloadKbps).toBe(30000);
    expect(sync?.uploadKbps).toBe(10000);
  });
});
