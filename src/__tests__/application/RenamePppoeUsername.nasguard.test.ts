/**
 * TDD — RenamePppoeUsername: NAS guard (CRITICAL fix-wave-2).
 *
 * El rename es un flujo SOLO-RADIUS: siempre usa orchestrator.createUser / deleteUser.
 * Por eso el rename SOLO está soportado para NAS de tipo `radius_orchestrator`.
 *
 * Bug confirmado: el use case no cargaba el NAS → no validaba el tipo → con
 * `PerNasEnforcementGateway` + `{} as NasServer`, nas.type===undefined ruteaba al
 * RouterOsEnforcementAdapter (MikroTik) → router.updateSecret(ipAddress: undefined) → 500.
 *
 * Fix:
 *   1. Inyectar `nasRepo: NasRepository` en el constructor (3er param, ANTES de enforcement).
 *   2. Cargar el NAS real en execute() y guardar (se usa para apply).
 *   3. Guard: si !routesViaOrchestrator(nas.type) → PppoeRenameNasNotSupportedError (422).
 *   4. Pasar el NAS real a enforcement.apply() en vez de `{} as NasServer`.
 *   5. app.ts: inyectar `radiusEnforcement` (OrchestratorEnforcementAdapter) en vez de enforcementGw.
 *
 * Tests (rojo → verde):
 *   A. radius_orchestrator + blocked → enforcement re-aplicado (block) sobre el nuevo username → OK.
 *   B. radius_orchestrator + reduced → enforcement re-aplicado (reduce) → OK.
 *   C. mikrotik_api NAS → PppoeRenameNasNotSupportedError ANTES de tocar el orchestrator (no fantasma).
 *   D. NAS no encontrado → NasNotFoundError (dato corrupto: PPPoE apunta a NAS inexistente).
 */
import { RenamePppoeUsername } from '@application/use-cases/RenamePppoeUsername';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { OrchestratorEnforcementAdapter } from '@infrastructure/adapters/orchestrator/OrchestratorEnforcementAdapter';
import { PppoeRenameNasNotSupportedError, NasNotFoundError } from '@domain/errors/pppoe';

// InMemoryNasRepository IDs:
//   '1' → mikrotik_api (ipAddress: '192.168.1.1')
//   '3' → radius_orchestrator (ipAddress: '10.0.0.5')
const NAS_RADIUS = '3';
const NAS_MIKROTIK = '1';
const REDUCED_PLAN = 'IP-REDUCCION';

function setup() {
  const pppoeRepo    = new InMemoryPppoeServiceRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();
  const nasRepo      = new InMemoryNasRepository();
  const enforcement  = new OrchestratorEnforcementAdapter(orchestrator, REDUCED_PLAN);
  // Constructor nuevo: (pppoeRepo, orchestrator, nasRepo, enforcement?)
  const useCase      = new RenamePppoeUsername(pppoeRepo, orchestrator, nasRepo, enforcement);
  return { pppoeRepo, orchestrator, nasRepo, useCase };
}

// ── A. radius_orchestrator + blocked ─────────────────────────────────────────

describe('RenamePppoeUsername NAS guard — A: radius_orchestrator + blocked → OK', () => {
  it('enforcement re-aplicado (block) sobre el nuevo username; rename completa sin 500', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();

    const old = await pppoeRepo.upsertByUsername({
      username:      'blocked-old',
      password:      'p',
      profile:       'IP-Air-5M',
      nasId:         NAS_RADIUS,   // ← NAS radius_orchestrator
      contractId:    null,
      status:        'enabled',
      enforcedState: 'blocked',
    });
    await orchestrator.createUser({ username: 'blocked-old', password: 'p', plan: 'IP-Air-5M' });

    const result = await useCase.execute({ id: old.id, newUsername: 'blocked-new' });

    expect(result.status).toBe('ok');
    expect(result.username).toBe('blocked-new');

    // El nuevo username está suspendido en el RADIUS
    expect(orchestrator.isSuspended('blocked-new')).toBe(true);

    // El espejo preserva enforcedState
    const row = await pppoeRepo.findByUsername('blocked-new');
    expect(row!.enforcedState).toBe('blocked');

    // El viejo fue borrado del orchestrator
    const ops = orchestrator.calls.map(c => `${c.op}:${c.username}`);
    expect(ops).toContain('deleteUser:blocked-old');
  });
});

// ── B. radius_orchestrator + reduced ─────────────────────────────────────────

describe('RenamePppoeUsername NAS guard — B: radius_orchestrator + reduced → OK', () => {
  it('enforcement re-aplicado (reduce) sobre el nuevo username; plan cambia al de reducción', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();

    const old = await pppoeRepo.upsertByUsername({
      username:      'reduced-old',
      password:      'p',
      profile:       'IP-Air-10M',
      nasId:         NAS_RADIUS,
      contractId:    null,
      status:        'enabled',
      enforcedState: 'reduced',
    });
    await orchestrator.createUser({ username: 'reduced-old', password: 'p', plan: 'IP-Air-10M' });

    const result = await useCase.execute({ id: old.id, newUsername: 'reduced-new' });

    expect(result.status).toBe('ok');

    // El plan del nuevo username es el de reducción (no el comercial)
    expect(orchestrator.planOf('reduced-new')).toBe(REDUCED_PLAN);

    const row = await pppoeRepo.findByUsername('reduced-new');
    expect(row!.enforcedState).toBe('reduced');
  });
});

// ── C. mikrotik_api NAS → guard rechaza ──────────────────────────────────────

describe('RenamePppoeUsername NAS guard — C: mikrotik_api NAS → rechazado', () => {
  it('PppoeRenameNasNotSupportedError ANTES de tocar el orchestrator (sin fantasma en RADIUS)', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();

    const old = await pppoeRepo.upsertByUsername({
      username:      'mkuser-old',
      password:      'p',
      profile:       'P1',
      nasId:         NAS_MIKROTIK,  // ← mikrotik_api, NO soportado
      contractId:    null,
      status:        'enabled',
      enforcedState: 'blocked',
    });

    await expect(useCase.execute({ id: old.id, newUsername: 'mkuser-new' }))
      .rejects.toBeInstanceOf(PppoeRenameNasNotSupportedError);

    // El orchestrator NO fue tocado en ningún momento (no hay fantasma)
    expect(orchestrator.calls.filter(c => c.op === 'createUser')).toHaveLength(0);

    // El espejo viejo sobrevive intacto
    const viejo = await pppoeRepo.findByUsername('mkuser-old');
    expect(viejo).not.toBeNull();
    expect(viejo!.id).toBe(old.id);
  });

  it('PppoeRenameNasNotSupportedError antes del createUser (active también)', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();

    const old = await pppoeRepo.upsertByUsername({
      username:   'mkactive',
      password:   'p',
      profile:    'P1',
      nasId:      NAS_MIKROTIK,
      contractId: null,
    });

    await expect(useCase.execute({ id: old.id, newUsername: 'mkactive-new' }))
      .rejects.toBeInstanceOf(PppoeRenameNasNotSupportedError);

    expect(orchestrator.calls.filter(c => c.op === 'createUser')).toHaveLength(0);
  });
});

// ── D. NAS no encontrado ──────────────────────────────────────────────────────

describe('RenamePppoeUsername NAS guard — D: NAS no encontrado → NasNotFoundError', () => {
  it('PPPoE con nasId inexistente → NasNotFoundError (dato corrupto; no fantasma)', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();

    const old = await pppoeRepo.upsertByUsername({
      username:   'orphan-nas',
      password:   'p',
      profile:    'P1',
      nasId:      'nonexistent-nas-999',  // no está en InMemoryNasRepository
      contractId: null,
    });

    await expect(useCase.execute({ id: old.id, newUsername: 'orphan-nas-new' }))
      .rejects.toBeInstanceOf(NasNotFoundError);

    expect(orchestrator.calls.filter(c => c.op === 'createUser')).toHaveLength(0);
  });
});
