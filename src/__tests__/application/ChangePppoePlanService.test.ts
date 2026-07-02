/**
 * ChangePppoePlanService.test.ts — TDD (task 2.1)
 *
 * Tests the extracted ChangePppoePlanService: routes by nas.type,
 * upserts DB, records 'modified' event best-effort.
 *
 * Covers:
 *  - radius_orchestrator NAS: calls orchestrator.changePlan with applyInSession:true
 *  - non-orchestrator NAS: calls router.updateSecret (profile updated in secrets store)
 *  - event 'modified' is recorded with actor + reason + notes old→new
 *  - no event when contractId is null (orphan)
 *  - event failure is best-effort (does NOT throw)
 *
 * NAS IDs from InMemoryNasRepository:
 *   '1' = mikrotik_api (MikroTik central)
 *   '3' = radius_orchestrator (MikroTik sucursal — type is radius_orchestrator in the fixture)
 */
import { ChangePppoePlanService } from '@application/services/ChangePppoePlanService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';

// From InMemoryNasRepository defaults: id='3' is radius_orchestrator, id='1' is mikrotik_api
const ORCH_NAS_ID    = '3';
const MIKROTIK_NAS_ID = '1';

async function buildService() {
  const pppoeRepo   = new InMemoryPppoeServiceRepository();
  const nasRepo     = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();
  const routerGw    = new InMemoryRouterGateway();
  const catalogRepo  = new InMemoryServiceCatalogRepository();
  const eventRepo   = new InMemoryContractServiceEventRepository();

  await catalogRepo.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });

  const svc = new ChangePppoePlanService(pppoeRepo, routerGw, nasRepo, orchestrator, catalogRepo, eventRepo);
  return { svc, pppoeRepo, nasRepo, orchestrator, routerGw, catalogRepo, eventRepo };
}

// ════════════════════════════════════════════════════════════════════════════
describe('ChangePppoePlanService.changePlan — radius_orchestrator NAS', () => {
  it('calls orchestrator.changePlan with applyInSession:true', async () => {
    const fx = await buildService();
    const service = await fx.pppoeRepo.upsertByUsername({
      username: 'user@test', password: 'pw', profile: 'IP-30M',
      nasId: ORCH_NAS_ID, contractId: null, status: 'enabled',
    });
    const nasServer = await fx.nasRepo.findNasServerById(ORCH_NAS_ID);

    await fx.svc.changePlan({
      service,
      nas: nasServer!,
      profile: 'IP-50M',
      reason: null,
      actorId: null,
      actorName: '',
    });

    const planCalls = fx.orchestrator.calls.filter(c => c.op === 'changePlan');
    expect(planCalls).toHaveLength(1);
    expect(planCalls[0]!.username).toBe('user@test');
    expect(planCalls[0]!.arg).toMatchObject({ applyInSession: true });
  });

  it('upserts DB with the new profile after orchestrator call', async () => {
    const fx = await buildService();
    const service = await fx.pppoeRepo.upsertByUsername({
      username: 'user@test', password: 'pw', profile: 'IP-30M',
      nasId: ORCH_NAS_ID, contractId: null, status: 'enabled',
    });
    const nasServer = await fx.nasRepo.findNasServerById(ORCH_NAS_ID);

    await fx.svc.changePlan({ service, nas: nasServer!, profile: 'IP-50M', reason: null, actorId: null, actorName: '' });

    const updated = await fx.pppoeRepo.findByUsername('user@test');
    expect(updated!.profile).toBe('IP-50M');
  });
});

describe('ChangePppoePlanService.changePlan — non-orchestrator NAS (mikrotik_api)', () => {
  it('calls router.updateSecret (verifiable via secrets store) and upserts DB', async () => {
    const fx = await buildService();
    // Seed the secret in the router first so updateSecret finds it
    const mikrotikNas = await fx.nasRepo.findNasServerById(MIKROTIK_NAS_ID);
    await fx.routerGw.createSecret(
      { ipAddress: mikrotikNas!.ipAddress, apiPort: mikrotikNas!.apiPort! },
      { username: 'mkt@test', password: 'pw', profile: 'IP-30M' },
    );

    const service = await fx.pppoeRepo.upsertByUsername({
      username: 'mkt@test', password: 'pw', profile: 'IP-30M',
      nasId: MIKROTIK_NAS_ID, contractId: null, status: 'enabled',
    });

    await fx.svc.changePlan({ service, nas: mikrotikNas!, profile: 'IP-50M', reason: null, actorId: null, actorName: '' });

    // Verify DB updated
    const updated = await fx.pppoeRepo.findByUsername('mkt@test');
    expect(updated!.profile).toBe('IP-50M');

    // Verify secret in router updated (updateSecret modifies in place)
    const secrets = await fx.routerGw.listSecrets({ ipAddress: mikrotikNas!.ipAddress, apiPort: mikrotikNas!.apiPort! });
    const secret = secrets.find(s => s.username === 'mkt@test');
    expect(secret?.profile).toBe('IP-50M');
  });

  it('does NOT call orchestrator for non-orchestrator NAS', async () => {
    const fx = await buildService();
    const mikrotikNas = await fx.nasRepo.findNasServerById(MIKROTIK_NAS_ID);
    const service = await fx.pppoeRepo.upsertByUsername({
      username: 'mkt@test', password: 'pw', profile: 'IP-30M',
      nasId: MIKROTIK_NAS_ID, contractId: null, status: 'enabled',
    });

    await fx.svc.changePlan({ service, nas: mikrotikNas!, profile: 'IP-50M', reason: null, actorId: null, actorName: '' });

    const orchCalls = fx.orchestrator.calls.filter(c => c.op === 'changePlan');
    expect(orchCalls).toHaveLength(0);
  });
});

describe('ChangePppoePlanService.changePlan — event recording', () => {
  it('records modified event with actor + reason + old→new notes when contractId is set', async () => {
    const fx = await buildService();
    const service = await fx.pppoeRepo.upsertByUsername({
      username: 'user@test', password: 'pw', profile: 'IP-30M',
      nasId: ORCH_NAS_ID, contractId: 'ctr-1', status: 'enabled',
    });
    const nasServer = await fx.nasRepo.findNasServerById(ORCH_NAS_ID);

    await fx.svc.changePlan({
      service,
      nas: nasServer!,
      profile: 'IP-50M',
      reason: 'promo upgrade',
      actorId: 'actor-1',
      actorName: 'operador1',
    });

    const events = await fx.eventRepo.listByContract('ctr-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('modified');
    expect(events[0]!.reason).toBe('promo upgrade');
    expect(events[0]!.actorId).toBe('actor-1');
    expect(events[0]!.actorName).toBe('operador1');
    expect(events[0]!.notes).toBe('IP-30M → IP-50M');
  });

  it('does NOT record event when contractId is null (orphan service)', async () => {
    const fx = await buildService();
    const service = await fx.pppoeRepo.upsertByUsername({
      username: 'orphan@test', password: 'pw', profile: 'IP-30M',
      nasId: ORCH_NAS_ID, contractId: null, status: 'enabled',
    });
    const nasServer = await fx.nasRepo.findNasServerById(ORCH_NAS_ID);

    await fx.svc.changePlan({ service, nas: nasServer!, profile: 'IP-50M', reason: null, actorId: null, actorName: '' });

    // The orphan has no contract, so no event should be recorded anywhere
    expect(fx.eventRepo.all()).toHaveLength(0);
  });

  it('event failure is best-effort — changePlan still succeeds and DB is updated', async () => {
    const fx = await buildService();
    const throwingCatalogRepo: ServiceCatalogRepository = {
      getByName: async () => { throw new Error('catalog unavailable'); },
      create:      async () => { throw new Error('not implemented'); },
      list:        async () => [],
      getById:     async () => null,
      update:      async () => null,
      delete:      async () => false,
      countInUse:  async () => 0,
    };
    const svcWithBadCatalog = new ChangePppoePlanService(
      fx.pppoeRepo, fx.routerGw, fx.nasRepo, fx.orchestrator,
      throwingCatalogRepo,
      fx.eventRepo,
    );
    const service = await fx.pppoeRepo.upsertByUsername({
      username: 'user@test', password: 'pw', profile: 'IP-30M',
      nasId: ORCH_NAS_ID, contractId: 'ctr-1', status: 'enabled',
    });
    const nasServer = await fx.nasRepo.findNasServerById(ORCH_NAS_ID);

    // Should not throw even though catalog throws
    await expect(svcWithBadCatalog.changePlan({
      service, nas: nasServer!, profile: 'IP-50M', reason: null, actorId: null, actorName: '',
    })).resolves.not.toThrow();

    // DB should still be updated
    const updated = await fx.pppoeRepo.findByUsername('user@test');
    expect(updated!.profile).toBe('IP-50M');
  });
});
