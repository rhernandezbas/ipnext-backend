/**
 * TDD — RenamePppoeUsername: enforcement, profile, username-taken (pppoe-full-management fix-wave).
 *
 * C1: Rename pierde el enforcement → cliente cortado recupera servicio
 *   blocked  → nuevo username queda suspendido en el orchestrator (misma semántica que el viejo)
 *   reduced  → nuevo username queda con plan de reducción en el orchestrator
 *   active   → no se aplica ningún enforcement al nuevo (sanity)
 *
 * W1: username-taken inconsistente
 *   username existe en orchestrator pero no en espejo → PppoeUsernameTakenError (no OrchestratorRejectedError)
 *
 * W2: profile null → PppoeProfileRequiredError ANTES de tocar el orchestrator
 */
import { RenamePppoeUsername } from '@application/use-cases/RenamePppoeUsername';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { OrchestratorEnforcementAdapter } from '@infrastructure/adapters/orchestrator/OrchestratorEnforcementAdapter';
import { PppoeUsernameTakenError, PppoeProfileRequiredError } from '@domain/errors/pppoe';

const REDUCED_PLAN = 'IP-REDUCCION';
// InMemoryNasRepository id '3' = radius_orchestrator — requerido por el guard del rename.
const NAS_RADIUS = '3';

function setup(orchOpts?: ConstructorParameters<typeof InMemoryRadiusOrchestratorGateway>[0]) {
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway(orchOpts);
  const nasRepo = new InMemoryNasRepository();
  const enforcement = new OrchestratorEnforcementAdapter(orchestrator, REDUCED_PLAN);
  // Constructor: (pppoeRepo, orchestrator, nasRepo, enforcement?)
  const useCase = new RenamePppoeUsername(pppoeRepo, orchestrator, nasRepo, enforcement);
  return { pppoeRepo, orchestrator, useCase };
}

// ── C1: enforcement preservation ─────────────────────────────────────────────

describe('RenamePppoeUsername — C1: enforcement re-aplicado sobre el nuevo username', () => {
  it('C1a — blocked: nuevo username queda suspendido en el orchestrator', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();

    const old = await pppoeRepo.upsertByUsername({
      username: 'oldblocked',
      password: 'p',
      profile: 'IP-Air-5M',
      nasId: NAS_RADIUS,
      contractId: null,
      status: 'enabled',
      enforcedState: 'blocked',
    });
    await orchestrator.createUser({ username: 'oldblocked', password: 'p', plan: 'IP-Air-5M' });

    const result = await useCase.execute({ id: old.id, newUsername: 'newblocked' });

    expect(result.status).toBe('ok');
    expect(orchestrator.isSuspended('newblocked')).toBe(true);

    // El row espejo conserva el enforcedState
    const row = await pppoeRepo.findByUsername('newblocked');
    expect(row).not.toBeNull();
    expect(row!.enforcedState).toBe('blocked');
  });

  it('C1b — reduced: nuevo username queda con plan de reducción en el orchestrator', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();

    const old = await pppoeRepo.upsertByUsername({
      username: 'oldreduced',
      password: 'p',
      profile: 'IP-Air-5M',
      nasId: NAS_RADIUS,
      contractId: null,
      status: 'enabled',
      enforcedState: 'reduced',
    });
    await orchestrator.createUser({ username: 'oldreduced', password: 'p', plan: 'IP-Air-5M' });

    const result = await useCase.execute({ id: old.id, newUsername: 'newreduced' });

    expect(result.status).toBe('ok');
    // El plan del nuevo user es el de reducción (no el comercial)
    expect(orchestrator.planOf('newreduced')).toBe(REDUCED_PLAN);

    // El row espejo conserva el enforcedState
    const row = await pppoeRepo.findByUsername('newreduced');
    expect(row).not.toBeNull();
    expect(row!.enforcedState).toBe('reduced');
  });

  it('C1c — active: enforcement NO se aplica al nuevo (sanity)', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();

    const old = await pppoeRepo.upsertByUsername({
      username: 'oldactive',
      password: 'p',
      profile: 'IP-Air-5M',
      nasId: NAS_RADIUS,
      contractId: null,
      status: 'enabled',
      enforcedState: 'active',
    });
    await orchestrator.createUser({ username: 'oldactive', password: 'p', plan: 'IP-Air-5M' });

    await useCase.execute({ id: old.id, newUsername: 'newactive' });

    const opsForNew = orchestrator.calls
      .filter(c => c.username === 'newactive')
      .map(c => c.op);
    // Solo createUser, sin suspend ni changePlan
    expect(opsForNew).not.toContain('suspend');
    expect(opsForNew).not.toContain('changePlan');
    expect(orchestrator.isSuspended('newactive')).toBe(false);
  });

  it('C1d — blocked con contractId: contractId preservado + estado bloqueado', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();

    const old = await pppoeRepo.upsertByUsername({
      username: 'blocked-with-contract',
      password: 'p',
      profile: 'IP-Air-10M',
      nasId: NAS_RADIUS,
      contractId: 'ct-important',
      status: 'enabled',
      enforcedState: 'blocked',
    });
    await orchestrator.createUser({ username: 'blocked-with-contract', password: 'p', plan: 'IP-Air-10M' });

    const result = await useCase.execute({ id: old.id, newUsername: 'blocked-renamed' });

    expect(result.status).toBe('ok');
    expect(orchestrator.isSuspended('blocked-renamed')).toBe(true);
    const row = await pppoeRepo.findById(old.id);
    expect(row!.contractId).toBe('ct-important'); // contractId preservado
    expect(row!.enforcedState).toBe('blocked');
  });
});

// ── W1: username-taken desde el orchestrator ─────────────────────────────────

describe('RenamePppoeUsername — W1: username-taken inconsistente', () => {
  it('W1 — username existe en orchestrator pero no en espejo → PppoeUsernameTakenError (no OrchestratorRejectedError)', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();

    // Sembrar el viejo en espejo + orchestrator
    const old = await pppoeRepo.upsertByUsername({
      username: 'old-for-w1',
      password: 'p',
      profile: 'P1',
      nasId: NAS_RADIUS,
      contractId: null,
    });
    await orchestrator.createUser({ username: 'old-for-w1', password: 'p', plan: 'P1' });

    // 'taken-in-orch' existe en el orchestrator pero NO en el espejo
    await orchestrator.createUser({ username: 'taken-in-orch', password: 'x', plan: 'P1' });
    // (NO insertamos en pppoeRepo → espejo lo desconoce)

    await expect(useCase.execute({ id: old.id, newUsername: 'taken-in-orch' }))
      .rejects.toBeInstanceOf(PppoeUsernameTakenError);
  });
});

// ── W2: profile null → PppoeProfileRequiredError ────────────────────────────

describe('RenamePppoeUsername — W2: profile null requerido', () => {
  it('W2 — old.profile=null → PppoeProfileRequiredError ANTES de tocar el orchestrator', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();

    const old = await pppoeRepo.upsertByUsername({
      username: 'noprofile',
      password: 'p',
      profile: null,
      nasId: NAS_RADIUS,
      contractId: null,
    });

    await expect(useCase.execute({ id: old.id, newUsername: 'noprofile-new' }))
      .rejects.toBeInstanceOf(PppoeProfileRequiredError);

    // Orchestrator NO fue tocado en ningún momento
    expect(orchestrator.calls.filter(c => c.op === 'createUser')).toHaveLength(0);
  });

  it('W2 — old.profile vacío → PppoeProfileRequiredError ANTES de tocar el orchestrator', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();

    // Simular profile vacío (forzado vía cast porque el tipo usa null)
    const old = await pppoeRepo.upsertByUsername({
      username: 'emptyprofile',
      password: 'p',
      profile: null,
      nasId: NAS_RADIUS,
      contractId: null,
    });

    await expect(useCase.execute({ id: old.id, newUsername: 'emptyprofile-new' }))
      .rejects.toBeInstanceOf(PppoeProfileRequiredError);

    expect(orchestrator.calls.filter(c => c.op === 'createUser')).toHaveLength(0);
  });
});
