/**
 * UpdatePppoeService.combinedFields.test.ts — F2 fix-wave (pppoe-search-bulk-plan review, R1).
 *
 * TDD: escritos ANTES del fix. Regresión: antes del fix, CUALQUIER patch que incluyera `profile`
 * delegaba a ChangePppoePlanService (aunque trajera password/status/remoteAddress también),
 * lo que cambiaba la atomicidad observable de PATCH /api/pppoe/:id en producción:
 *   - profile quedaba COMMITEADO + EVENTADO aunque un campo posterior (ej. suspend) tirara después.
 *   - el path Mikrotik hacía DOS `updateSecret` (uno para profile via changePlanSvc, otro para
 *     el resto) en vez de UNO solo combinando todos los campos.
 *
 * El fix: delegar a ChangePppoePlanService SOLO cuando `profile` es el ÚNICO campo del patch.
 * Los combinados van COMPLETOS por el camino legacy inline (comportamiento observable EXACTO
 * al original, antes de que existiera la delegación).
 *
 * Construidos COMO PROD: catalogRepo + eventRepo presentes (changePlanSvc no-null).
 *
 * NAS IDs from InMemoryNasRepository:
 *   '1' = mikrotik_api (MikroTik central)
 *   '3' = radius_orchestrator (MikroTik sucursal)
 */
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';

const RADIUS_NAS_ID = '3';
const MIKROTIK_NAS_ID = '1';
const CONTRACT_ID = 'C1';

async function seedCatalog(catalogRepo: InMemoryServiceCatalogRepository) {
  return catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
}

describe('UpdatePppoeService — F2 fix-wave: delegación SOLO para profile-solo', () => {
  let repo: InMemoryPppoeServiceRepository;
  let router: InMemoryRouterGateway;
  let nasRepo: InMemoryNasRepository;
  let orchestrator: InMemoryRadiusOrchestratorGateway;
  let catalogRepo: InMemoryServiceCatalogRepository;
  let eventRepo: InMemoryContractServiceEventRepository;

  beforeEach(() => {
    repo = new InMemoryPppoeServiceRepository();
    router = new InMemoryRouterGateway();
    nasRepo = new InMemoryNasRepository();
    orchestrator = new InMemoryRadiusOrchestratorGateway();
    catalogRepo = new InMemoryServiceCatalogRepository();
    eventRepo = new InMemoryContractServiceEventRepository();
  });

  async function seedRadiusWithContract(): Promise<string> {
    const row = await repo.upsertByUsername({
      username: 'juanperez',
      password: 'oldpass',
      profile: 'IP-Air-30-10',
      remoteAddress: '100.64.10.10',
      nasId: RADIUS_NAS_ID,
      contractId: CONTRACT_ID,
      status: 'enabled',
    });
    return row.id;
  }

  // ── (a) {profile,password} orchestrator: changePlan+changePassword, upsert único, evento ──────
  it('(a) {profile,password} orchestrator: changePlan + changePassword, UN upsert, evento registrado', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    const upsertSpy = jest.spyOn(repo, 'upsertByUsername');

    await uc.execute({
      id,
      profile: 'IP-Air-40-15',
      password: 'newpass123',
      actorId: 'A1',
      actorName: 'Operador1',
    });

    // Both control-plane calls happened (combined patch, inline path, NOT delegation).
    const planCalls = orchestrator.calls.filter(c => c.op === 'changePlan' && c.username === 'juanperez');
    const pwCalls = orchestrator.calls.filter(c => c.op === 'changePassword' && c.username === 'juanperez');
    expect(planCalls).toHaveLength(1);
    expect(pwCalls).toHaveLength(1);

    // Exactly ONE upsert (not two — delegation would have upserted once for profile, then
    // again for the rest).
    expect(upsertSpy).toHaveBeenCalledTimes(1);

    const after = await repo.findById(id);
    expect(after!.profile).toBe('IP-Air-40-15');
    expect(after!.password).toBe('newpass123');

    // Event recorded (same as before the fix — combined patches still record the event).
    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('modified');
    expect(events[0]!.notes).toBe('IP-Air-30-10 → IP-Air-40-15');
  });

  // ── (b) {profile,status:'disabled'}: si suspend TIRA → NO upsert de profile NI evento ─────────
  it('(b) {profile,status:disabled} orchestrator: si suspend TIRA → NO hay upsert de profile NI evento (atomicidad legacy)', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    jest.spyOn(orchestrator, 'suspend').mockRejectedValueOnce(new Error('suspend failed (simulado)'));

    await expect(uc.execute({
      id,
      profile: 'IP-Air-40-15',
      status: 'disabled',
      actorId: 'A1',
      actorName: 'Operador1',
    })).rejects.toThrow('suspend failed (simulado)');

    // DB unchanged — profile did NOT commit even though changePlan (via inline orchestrator call)
    // ran before suspend threw. This is the ORIGINAL legacy atomicity: upsert only happens after
    // ALL control-plane calls succeed.
    const after = await repo.findById(id);
    expect(after!.profile).toBe('IP-Air-30-10');
    expect(after!.status).toBe('enabled');

    // No event either — event recording happens strictly after the upsert.
    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(0);
  });

  // ── (c) mikrotik {profile,password}: UN SOLO updateSecret con ambos campos ─────────────────────
  it('(c) mikrotik {profile,password}: UN SOLO updateSecret con ambos campos combinados (no dos llamadas)', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const mikrotikNas = await nasRepo.findNasServerById(MIKROTIK_NAS_ID);
    await router.createSecret(
      { ipAddress: mikrotikNas!.ipAddress, apiPort: mikrotikNas!.apiPort! },
      { username: 'mkt@test', password: 'oldpass', profile: 'IP-30M' },
    );
    const row = await repo.upsertByUsername({
      username: 'mkt@test',
      password: 'oldpass',
      profile: 'IP-30M',
      nasId: MIKROTIK_NAS_ID,
      contractId: CONTRACT_ID,
      status: 'enabled',
    });
    await seedCatalog(catalogRepo);

    const updateSecretSpy = jest.spyOn(router, 'updateSecret');

    await uc.execute({
      id: row.id,
      profile: 'IP-50M',
      password: 'newpass456',
      actorId: 'A1',
      actorName: 'Operador1',
    });

    // Exactly ONE updateSecret call, with BOTH fields combined in the same patch. Before the fix,
    // delegation would have issued a first updateSecret (profile only, via changePlanSvc) and a
    // second one (password only, via the "fall through" block) — TWO calls.
    expect(updateSecretSpy).toHaveBeenCalledTimes(1);
    expect(updateSecretSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: mikrotikNas!.ipAddress }),
      'mkt@test',
      expect.objectContaining({ profile: 'IP-50M', password: 'newpass456' }),
    );

    const secrets = await router.listSecrets({ ipAddress: mikrotikNas!.ipAddress, apiPort: mikrotikNas!.apiPort! });
    const secret = secrets.find(s => s.username === 'mkt@test');
    expect(secret?.profile).toBe('IP-50M');
  });

  // ── (d) profile-solo sigue por delegación — pineado por UpdatePppoeService.events.test.ts ──────
  it('(d) profile-solo: sigue delegando (applyInSession:true) — smoke check, ya pineado en events.test', async () => {
    const uc = new UpdatePppoeService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo);
    const id = await seedRadiusWithContract();
    await seedCatalog(catalogRepo);

    await uc.execute({ id, profile: 'IP-Air-40-15', actorId: 'A1', actorName: 'Operador1' });

    const changePlanCalls = orchestrator.calls.filter(c => c.op === 'changePlan' && c.username === 'juanperez');
    expect(changePlanCalls).toHaveLength(1);
    expect(changePlanCalls[0]!.arg).toMatchObject({ plan: 'IP-Air-40-15', applyInSession: true });

    const events = await eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
  });
});
