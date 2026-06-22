import { CreatePlan } from '@application/use-cases/CreatePlan';
import { UpdatePlan } from '@application/use-cases/UpdatePlan';
import { DeletePlan } from '@application/use-cases/DeletePlan';
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';

/**
 * Los planes de ENFORCEMENT (códigos IP-REDUCCION, IP-BAJA) NO se sincronizan al orchestrator: son
 * grupos de sistema que el orchestrator posee y reserva POR CÓDIGO. El criterio de exclusión es el
 * CÓDIGO (inmutable), NO la categoría (editable) — así Prominense reserva la misma dimensión que
 * `is_reserved_groupname` del orchestrator y no hay mismatch ni transiciones de categoría.
 */
describe('Planes de enforcement (por código) NO se sincronizan al orchestrator', () => {
  it('CreatePlan NO llama syncPlan para un código de enforcement, pero lo crea en la DB local', async () => {
    const repo = new InMemoryPlanRepository();
    const gw = new InMemoryRadiusOrchestratorGateway({});
    const uc = new CreatePlan(repo, gw);

    const plan = await uc.execute({
      code: 'IP-REDUCCION', name: 'Reduccion', category: 'Corte', downloadKbps: 256, uploadKbps: 256,
    });

    expect(plan.code).toBe('IP-REDUCCION');
    expect(gw.planCalls.filter((c) => c.op === 'syncPlan')).toHaveLength(0);
    expect(await repo.findByCode('IP-REDUCCION')).not.toBeNull();
  });

  it('el CRITERIO es el código, NO la categoría: código reservado con categoría no-Corte tampoco sincroniza', async () => {
    const repo = new InMemoryPlanRepository();
    const gw = new InMemoryRadiusOrchestratorGateway({});
    const uc = new CreatePlan(repo, gw);

    // Categoría 'Air' pero código reservado → igual NO se sincroniza (el orchestrator lo rechazaría).
    await uc.execute({
      code: 'IP-BAJA', name: 'Baja', category: 'Air', downloadKbps: 1, uploadKbps: 1,
    });

    expect(gw.planCalls.filter((c) => c.op === 'syncPlan')).toHaveLength(0);
  });

  it('UpdatePlan NO llama syncPlan para un código de enforcement (el code es inmutable)', async () => {
    const repo = new InMemoryPlanRepository();
    const created = await repo.upsertByCode({
      code: 'IP-BAJA', name: 'Baja', category: 'Corte', downloadKbps: 1, uploadKbps: 1,
    });
    const gw = new InMemoryRadiusOrchestratorGateway({});
    const uc = new UpdatePlan(repo, gw);

    await uc.execute({ id: created.id, downloadKbps: 1, uploadKbps: 1 });

    expect(gw.planCalls.filter((c) => c.op === 'syncPlan')).toHaveLength(0);
  });

  it('DeletePlan NO llama deletePlan para un código de enforcement, pero lo borra de la DB local', async () => {
    const repo = new InMemoryPlanRepository();
    const created = await repo.upsertByCode({
      code: 'IP-REDUCCION', name: 'Reduccion', category: 'Corte', downloadKbps: 256, uploadKbps: 256,
    });
    const gw = new InMemoryRadiusOrchestratorGateway({});
    const uc = new DeletePlan(repo, gw);

    await uc.execute(created.id);

    expect(gw.planCalls.filter((c) => c.op === 'deletePlan')).toHaveLength(0);
    expect(await repo.findById(created.id)).toBeNull();
  });

  it('un plan comercial (código NO reservado) SÍ sincroniza, aunque su categoría fuese Corte', async () => {
    const repo = new InMemoryPlanRepository();
    const gw = new InMemoryRadiusOrchestratorGateway({});
    const uc = new CreatePlan(repo, gw);

    // Categoría 'Corte' pero código comercial → SÍ sincroniza (el criterio es el código, no la categoría).
    await uc.execute({
      code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Corte', downloadKbps: 30000, uploadKbps: 10000,
    });

    expect(gw.planCalls.filter((c) => c.op === 'syncPlan' && c.code === 'IP-Air-30-10')).toHaveLength(1);
  });
});
