/**
 * BulkChangePppoePlan.test.ts — TDD (tasks 3.1, 3.2, 3.3)
 *
 * Tests the BulkChangePppoePlan use case:
 *  - dedup of ids
 *  - tope >200 → BulkTooLargeError
 *  - fail-fast: plan inexistente → PlanNotFoundError (cero mutación)
 *  - bulk feliz: all ok
 *  - ítem que falla → best-effort (lote sigue)
 *  - id inexistente → failed with PPPOE_NOT_FOUND
 *  - evento 'modified' por ítem OK (via ChangePppoePlanService)
 *  - ítem sin contrato no registra evento
 *
 * NAS IDs from InMemoryNasRepository:
 *   '3' = radius_orchestrator
 */
import { BulkChangePppoePlan } from '@application/use-cases/BulkChangePppoePlan';
import { ChangePppoePlanService } from '@application/services/ChangePppoePlanService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { BulkEmptyIdsError, BulkTooLargeError, PlanNotFoundForBulkError } from '@domain/errors/pppoe-bulk';
import type { PppoeService } from '@domain/entities/pppoeService';
import type { NasServer } from '@domain/entities/nas';

const ORCH_NAS_ID = '3'; // radius_orchestrator in InMemoryNasRepository
const MIKROTIK_NAS_ID = '1'; // mikrotik_api in InMemoryNasRepository

/** F1 fix-wave test double: NAS lookup throws for the given ids, delegates the rest to a real repo. */
class FlakyNasRepository extends InMemoryNasRepository {
  constructor(private readonly throwForIds: Set<string>) {
    super();
  }
  async findNasServerById(id: string): Promise<NasServer | null> {
    if (this.throwForIds.has(id)) throw new Error('DB down resolving NAS');
    return super.findNasServerById(id);
  }
}

/** F1 fix-wave test double: PppoeService lookup throws for the given ids, delegates the rest. */
class FlakyPppoeServiceRepository extends InMemoryPppoeServiceRepository {
  constructor(private readonly throwForIds: Set<string>) {
    super();
  }
  async findById(id: string): Promise<PppoeService | null> {
    if (this.throwForIds.has(id)) throw new Error('DB down resolving PPPoE');
    return super.findById(id);
  }
}

async function buildUseCase() {
  const pppoeRepo   = new InMemoryPppoeServiceRepository();
  const planRepo    = new InMemoryPlanRepository();
  const nasRepo     = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();
  const routerGw    = new InMemoryRouterGateway();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const eventRepo   = new InMemoryContractServiceEventRepository();

  await catalogRepo.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });

  const changePlanSvc = new ChangePppoePlanService(pppoeRepo, routerGw, nasRepo, orchestrator, catalogRepo, eventRepo);
  const bulkUseCase   = new BulkChangePppoePlan(pppoeRepo, planRepo, nasRepo, changePlanSvc, { throttleMs: 0 });

  return { bulkUseCase, pppoeRepo, planRepo, orchestrator, eventRepo };
}

async function seedPlan(planRepo: InMemoryPlanRepository, code = 'IP-50M') {
  return planRepo.upsertByCode({ code, name: code, category: 'Internet', downloadKbps: 50000, uploadKbps: 10000 });
}

async function seedService(
  pppoeRepo: InMemoryPppoeServiceRepository,
  overrides: { username?: string; contractId?: string | null; profile?: string } = {},
) {
  return pppoeRepo.upsertByUsername({
    username:   overrides.username ?? 'user@test',
    password:   'pw',
    profile:    overrides.profile ?? 'IP-30M',
    nasId:      ORCH_NAS_ID,
    contractId: overrides.contractId !== undefined ? overrides.contractId : 'ctr-1',
    status:     'enabled',
  });
}

// ════════════════════════════════════════════════════════════════════════════
describe('BulkChangePppoePlan — validation', () => {
  it('tope >200 → BulkTooLargeError (cero mutación)', async () => {
    const { bulkUseCase, planRepo } = await buildUseCase();
    await seedPlan(planRepo);
    const ids = Array.from({ length: 201 }, (_, i) => `id-${i}`);

    await expect(bulkUseCase.execute({ ids, profile: 'IP-50M', reason: null, actorId: null, actorName: '' }))
      .rejects.toBeInstanceOf(BulkTooLargeError);
  });

  it('plan inexistente → PlanNotFoundForBulkError (fail-fast, cero mutación)', async () => {
    const { bulkUseCase, pppoeRepo } = await buildUseCase();
    const s1 = await seedService(pppoeRepo, { username: 's1@test' });
    const s2 = await seedService(pppoeRepo, { username: 's2@test', contractId: 'ctr-2' });

    await expect(bulkUseCase.execute({
      ids: [s1.id, s2.id],
      profile: 'PLAN-NO-EXISTE',
      reason: null,
      actorId: null,
      actorName: '',
    })).rejects.toBeInstanceOf(PlanNotFoundForBulkError);

    // Cero mutación: profiles unchanged
    const u1 = await pppoeRepo.findById(s1.id);
    const u2 = await pppoeRepo.findById(s2.id);
    expect(u1!.profile).toBe('IP-30M');
    expect(u2!.profile).toBe('IP-30M');
  });

  // S2 fix-wave: ids vacío directo al use case → error DEDICADO con mensaje claro, NO el texto
  // de BulkTooLargeError ("recibió 0 ids, máximo 200"), que es engañoso para un lote vacío.
  it('S2: ids vacíos (length=0) → BulkEmptyIdsError con mensaje "el lote está vacío" (NO el texto de BulkTooLargeError)', async () => {
    const { bulkUseCase, planRepo } = await buildUseCase();
    await seedPlan(planRepo);

    const promise = bulkUseCase.execute({ ids: [], profile: 'IP-50M', reason: null, actorId: null, actorName: '' });

    await expect(promise).rejects.toBeInstanceOf(BulkEmptyIdsError);
    await expect(promise).rejects.toMatchObject({ code: 'BULK_EMPTY_IDS' });
    await expect(promise).rejects.toThrow(/vacío/i);
    // NOT the misleading "recibió 0 ids, máximo 200" wording from BulkTooLargeError.
    await expect(promise).rejects.not.toThrow(/máximo permitido/i);
  });
});

describe('BulkChangePppoePlan — happy path', () => {
  it('bulk feliz: all services changed → { ok: [...], failed: [] }', async () => {
    const { bulkUseCase, pppoeRepo, planRepo } = await buildUseCase();
    await seedPlan(planRepo);
    const s1 = await seedService(pppoeRepo, { username: 's1@test', contractId: 'ctr-1' });
    const s2 = await seedService(pppoeRepo, { username: 's2@test', contractId: 'ctr-2' });
    const s3 = await seedService(pppoeRepo, { username: 's3@test', contractId: 'ctr-3' });

    const result = await bulkUseCase.execute({
      ids: [s1.id, s2.id, s3.id],
      profile: 'IP-50M',
      reason: null,
      actorId: null,
      actorName: '',
    });

    expect(result.ok).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    expect(result.ok).toContain(s1.id);
    expect(result.ok).toContain(s2.id);
    expect(result.ok).toContain(s3.id);

    // DB updated
    const u1 = await pppoeRepo.findById(s1.id);
    expect(u1!.profile).toBe('IP-50M');
  });

  it('deduplicates ids: same id twice → changes only once', async () => {
    const { bulkUseCase, pppoeRepo, planRepo, orchestrator } = await buildUseCase();
    await seedPlan(planRepo);
    const s1 = await seedService(pppoeRepo, { username: 's1@test' });

    const result = await bulkUseCase.execute({
      ids: [s1.id, s1.id, s1.id],
      profile: 'IP-50M',
      reason: null,
      actorId: null,
      actorName: '',
    });

    expect(result.ok).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    // orchestrator.changePlan called once (not 3 times)
    const planCalls = orchestrator.calls.filter(c => c.op === 'changePlan');
    expect(planCalls).toHaveLength(1);
  });
});

describe('BulkChangePppoePlan — best-effort (partial failure)', () => {
  it('ítem que falla → lote sigue; falló en failed[]', async () => {
    const { pppoeRepo, planRepo, orchestrator } = await buildUseCase();
    await seedPlan(planRepo);
    const s1 = await seedService(pppoeRepo, { username: 's1@test', contractId: 'ctr-1' });
    const s2 = await seedService(pppoeRepo, { username: 's2@test', contractId: 'ctr-2' });
    const s3 = await seedService(pppoeRepo, { username: 's3@test', contractId: 'ctr-3' });

    // Make s2 fail at the orchestrator level
    const failOrchestrator = new InMemoryRadiusOrchestratorGateway({ unreachable: [s2.username] });
    const nasRepo = new InMemoryNasRepository();
    const routerGw = new InMemoryRouterGateway();
    const catalogRepo = new InMemoryServiceCatalogRepository();
    const eventRepo = new InMemoryContractServiceEventRepository();
    await catalogRepo.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });

    const changePlanSvc = new ChangePppoePlanService(pppoeRepo, routerGw, nasRepo, failOrchestrator, catalogRepo, eventRepo);
    const bulkUseCase   = new BulkChangePppoePlan(pppoeRepo, planRepo, nasRepo, changePlanSvc, { throttleMs: 0 });

    const result = await bulkUseCase.execute({
      ids: [s1.id, s2.id, s3.id],
      profile: 'IP-50M',
      reason: null,
      actorId: null,
      actorName: '',
    });

    expect(result.ok).toHaveLength(2);
    expect(result.ok).toContain(s1.id);
    expect(result.ok).toContain(s3.id);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe(s2.id);
    expect(result.failed[0]!.username).toBe('s2@test');
    expect(result.failed[0]!.error).toBeTruthy();
  });

  it('id inexistente → failed with PPPOE_NOT_FOUND error string', async () => {
    const { bulkUseCase, pppoeRepo, planRepo } = await buildUseCase();
    await seedPlan(planRepo);
    const s1 = await seedService(pppoeRepo, { username: 's1@test' });

    const result = await bulkUseCase.execute({
      ids: [s1.id, 'no-existe'],
      profile: 'IP-50M',
      reason: null,
      actorId: null,
      actorName: '',
    });

    expect(result.ok).toContain(s1.id);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe('no-existe');
    expect(result.failed[0]!.username).toBe('');
    expect(result.failed[0]!.error).toContain('PPPOE_NOT_FOUND');
  });
});

describe('BulkChangePppoePlan — event recording', () => {
  it('evento modified por cada ítem OK con contractId', async () => {
    const { bulkUseCase, pppoeRepo, planRepo, eventRepo } = await buildUseCase();
    await seedPlan(planRepo);
    const s1 = await seedService(pppoeRepo, { username: 's1@test', contractId: 'ctr-1', profile: 'IP-30M' });
    const s2 = await seedService(pppoeRepo, { username: 's2@test', contractId: 'ctr-2', profile: 'IP-30M' });

    await bulkUseCase.execute({
      ids: [s1.id, s2.id],
      profile: 'IP-50M',
      reason: 'promo',
      actorId: 'actor-1',
      actorName: 'operador1',
    });

    const ev1 = await eventRepo.listByContract('ctr-1');
    const ev2 = await eventRepo.listByContract('ctr-2');
    expect(ev1).toHaveLength(1);
    expect(ev1[0]!.eventType).toBe('modified');
    expect(ev1[0]!.reason).toBe('promo');
    expect(ev1[0]!.notes).toBe('IP-30M → IP-50M');
    expect(ev2).toHaveLength(1);
  });

  it('ítem sin contractId (huérfano) no registra evento aunque plan cambie', async () => {
    const { bulkUseCase, pppoeRepo, planRepo, eventRepo } = await buildUseCase();
    await seedPlan(planRepo);
    const s = await seedService(pppoeRepo, { username: 's@test', contractId: null });

    await bulkUseCase.execute({ ids: [s.id], profile: 'IP-50M', reason: null, actorId: null, actorName: '' });

    // Service still changed
    const updated = await pppoeRepo.findById(s.id);
    expect(updated!.profile).toBe('IP-50M');
    // No event recorded (null contractId)
    expect(eventRepo.all()).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F1 fix-wave — best-effort blindado: aislamiento inter-carril + nunca rechaza por ítems.
describe('BulkChangePppoePlan — F1 fix-wave (aislamiento de fallas de lookup)', () => {
  it('F1(a): lookup de NAS que TIRA en un carril no afecta al otro carril (aislamiento inter-carril)', async () => {
    const pppoeRepo    = new InMemoryPppoeServiceRepository();
    const planRepo     = new InMemoryPlanRepository();
    const orchestrator = new InMemoryRadiusOrchestratorGateway();
    const routerGw     = new InMemoryRouterGateway();
    const catalogRepo  = new InMemoryServiceCatalogRepository();
    const eventRepo    = new InMemoryContractServiceEventRepository();
    await catalogRepo.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });
    await seedPlan(planRepo);

    // Group A: MIKROTIK_NAS_ID — its NAS lookup will throw.
    const sA = await pppoeRepo.upsertByUsername({
      username: 'a@test', password: 'pw', profile: 'IP-30M',
      nasId: MIKROTIK_NAS_ID, contractId: 'ctr-a', status: 'enabled',
    });
    // Group B: ORCH_NAS_ID — its NAS lookup succeeds.
    const sB = await pppoeRepo.upsertByUsername({
      username: 'b@test', password: 'pw', profile: 'IP-30M',
      nasId: ORCH_NAS_ID, contractId: 'ctr-b', status: 'enabled',
    });

    const flakyNasRepo = new FlakyNasRepository(new Set([MIKROTIK_NAS_ID]));
    const changePlanSvc = new ChangePppoePlanService(pppoeRepo, routerGw, flakyNasRepo, orchestrator, catalogRepo, eventRepo);
    const bulkUseCase = new BulkChangePppoePlan(pppoeRepo, planRepo, flakyNasRepo, changePlanSvc, { throttleMs: 0 });

    // Before F1 fix, this used to REJECT the whole execute() call. Now it must resolve.
    const result = await bulkUseCase.execute({
      ids: [sA.id, sB.id],
      profile: 'IP-50M',
      reason: null,
      actorId: null,
      actorName: '',
    });

    expect(result.ok).toEqual([sB.id]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe(sA.id);
    expect(result.failed[0]!.error).toContain('NAS_LOOKUP_FAILED');

    // Group B's item was actually mutated — the other lane's failure didn't zombie it out.
    const updatedB = await pppoeRepo.findById(sB.id);
    expect(updatedB!.profile).toBe('IP-50M');
  });

  it('F1(b): nasServer null (NAS_NOT_FOUND) por ítem → failed, el resto del lote sigue', async () => {
    const { bulkUseCase, pppoeRepo, planRepo } = await buildUseCase();
    await seedPlan(planRepo);
    const s1 = await seedService(pppoeRepo, { username: 's1@test' }); // valid ORCH_NAS_ID
    // Service pointing at a nasId that does not exist in InMemoryNasRepository.
    const s2 = await pppoeRepo.upsertByUsername({
      username: 's2@test', password: 'pw', profile: 'IP-30M',
      nasId: 'nas-inexistente', contractId: 'ctr-2', status: 'enabled',
    });

    const result = await bulkUseCase.execute({
      ids: [s1.id, s2.id],
      profile: 'IP-50M',
      reason: null,
      actorId: null,
      actorName: '',
    });

    expect(result.ok).toContain(s1.id);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe(s2.id);
    expect(result.failed[0]!.username).toBe('s2@test');
    expect(result.failed[0]!.error).toContain('NAS_NOT_FOUND');
  });

  it('F1(c): execute NUNCA rechaza por fallos de ítems, aunque lookup de NAS Y de PPPoE fallen a la vez', async () => {
    const orchestrator  = new InMemoryRadiusOrchestratorGateway();
    const routerGw      = new InMemoryRouterGateway();
    const catalogRepo   = new InMemoryServiceCatalogRepository();
    const eventRepo     = new InMemoryContractServiceEventRepository();
    const planRepo      = new InMemoryPlanRepository();
    await catalogRepo.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });
    await seedPlan(planRepo);

    const flakyPppoeRepo = new FlakyPppoeServiceRepository(new Set(['lookup-fail-id']));
    const sOk = await flakyPppoeRepo.upsertByUsername({
      username: 'ok@test', password: 'pw', profile: 'IP-30M',
      nasId: ORCH_NAS_ID, contractId: 'ctr-ok', status: 'enabled',
    });
    const sBadNas = await flakyPppoeRepo.upsertByUsername({
      username: 'badnas@test', password: 'pw', profile: 'IP-30M',
      nasId: MIKROTIK_NAS_ID, contractId: 'ctr-badnas', status: 'enabled',
    });

    const flakyNasRepo = new FlakyNasRepository(new Set([MIKROTIK_NAS_ID]));
    const changePlanSvc = new ChangePppoePlanService(flakyPppoeRepo, routerGw, flakyNasRepo, orchestrator, catalogRepo, eventRepo);
    const bulkUseCase = new BulkChangePppoePlan(flakyPppoeRepo, planRepo, flakyNasRepo, changePlanSvc, { throttleMs: 0 });

    // Must resolve (not reject) even with a lookup failure on BOTH the pre-flight resolution AND
    // the per-group NAS lookup.
    const result = await bulkUseCase.execute({
      ids: [sOk.id, sBadNas.id, 'lookup-fail-id'],
      profile: 'IP-50M',
      reason: null,
      actorId: null,
      actorName: '',
    });

    expect(result.ok).toEqual([sOk.id]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sBadNas.id, error: expect.stringContaining('NAS_LOOKUP_FAILED') }),
      expect.objectContaining({ id: 'lookup-fail-id', username: '', error: expect.stringContaining('PPPOE_LOOKUP_FAILED') }),
    ]));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// S1 fix-wave — el throttle NO corre después del último ítem del carril ni después de ítems
// que no tocaron el plano de control (NAS_NOT_FOUND).
describe('BulkChangePppoePlan — S1 fix-wave (throttle)', () => {
  it('S1(a): sleep NO corre después del ÚLTIMO ítem del carril (3 ítems exitosos → 2 llamadas a sleep)', async () => {
    const pppoeRepo    = new InMemoryPppoeServiceRepository();
    const planRepo     = new InMemoryPlanRepository();
    const nasRepo      = new InMemoryNasRepository();
    const orchestrator = new InMemoryRadiusOrchestratorGateway();
    const routerGw     = new InMemoryRouterGateway();
    const catalogRepo  = new InMemoryServiceCatalogRepository();
    const eventRepo    = new InMemoryContractServiceEventRepository();
    await catalogRepo.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });
    await seedPlan(planRepo);

    const s1 = await pppoeRepo.upsertByUsername({ username: 's1@test', password: 'pw', profile: 'IP-30M', nasId: ORCH_NAS_ID, contractId: 'ctr-1', status: 'enabled' });
    const s2 = await pppoeRepo.upsertByUsername({ username: 's2@test', password: 'pw', profile: 'IP-30M', nasId: ORCH_NAS_ID, contractId: 'ctr-2', status: 'enabled' });
    const s3 = await pppoeRepo.upsertByUsername({ username: 's3@test', password: 'pw', profile: 'IP-30M', nasId: ORCH_NAS_ID, contractId: 'ctr-3', status: 'enabled' });

    const sleepSpy = jest.fn(() => Promise.resolve());
    const changePlanSvc = new ChangePppoePlanService(pppoeRepo, routerGw, nasRepo, orchestrator, catalogRepo, eventRepo);
    const bulkUseCase = new BulkChangePppoePlan(pppoeRepo, planRepo, nasRepo, changePlanSvc, {
      throttleMs: 50,
      routerConcurrency: 1,
      sleep: sleepSpy,
    });

    const result = await bulkUseCase.execute({
      ids: [s1.id, s2.id, s3.id],
      profile: 'IP-50M',
      reason: null,
      actorId: null,
      actorName: '',
    });

    expect(result.ok).toHaveLength(3);
    // 3 items in the SAME lane → throttle between them, but NOT after the last one → 2 calls.
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

  it('S1(b): sleep NO corre por ítems NAS_NOT_FOUND (nunca tocaron el plano de control)', async () => {
    const pppoeRepo    = new InMemoryPppoeServiceRepository();
    const planRepo     = new InMemoryPlanRepository();
    const nasRepo      = new InMemoryNasRepository();
    const orchestrator = new InMemoryRadiusOrchestratorGateway();
    const routerGw     = new InMemoryRouterGateway();
    const catalogRepo  = new InMemoryServiceCatalogRepository();
    const eventRepo    = new InMemoryContractServiceEventRepository();
    await catalogRepo.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });
    await seedPlan(planRepo);

    // Both services point at a nasId that does not resolve → whole lane is NAS_NOT_FOUND.
    const s1 = await pppoeRepo.upsertByUsername({ username: 's1@test', password: 'pw', profile: 'IP-30M', nasId: 'nas-inexistente', contractId: 'ctr-1', status: 'enabled' });
    const s2 = await pppoeRepo.upsertByUsername({ username: 's2@test', password: 'pw', profile: 'IP-30M', nasId: 'nas-inexistente', contractId: 'ctr-2', status: 'enabled' });

    const sleepSpy = jest.fn(() => Promise.resolve());
    const changePlanSvc = new ChangePppoePlanService(pppoeRepo, routerGw, nasRepo, orchestrator, catalogRepo, eventRepo);
    const bulkUseCase = new BulkChangePppoePlan(pppoeRepo, planRepo, nasRepo, changePlanSvc, {
      throttleMs: 50,
      routerConcurrency: 1,
      sleep: sleepSpy,
    });

    const result = await bulkUseCase.execute({
      ids: [s1.id, s2.id],
      profile: 'IP-50M',
      reason: null,
      actorId: null,
      actorName: '',
    });

    expect(result.failed).toHaveLength(2);
    expect(result.failed.every(f => f.error.includes('NAS_NOT_FOUND'))).toBe(true);
    expect(sleepSpy).not.toHaveBeenCalled();
  });
});
