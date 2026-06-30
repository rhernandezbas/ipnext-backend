/**
 * TDD — CreatePppoeStandalone (pppoe-full-management Fase 2 + fix-wave).
 *
 * Crea un PPPoE directo al HA con contrato OPCIONAL:
 *   1. Valida username único (espejo).
 *   2. Valida NAS existe (NasNotFoundError si no).
 *   3. Rutea por tipo de NAS: radius_orchestrator → orchestrator; mikrotik_api → router.createSecret.
 *   4. Cuando contractId: delega a CreatePppoeService (Guard #4 + activación + evento).
 *   5. Sin contractId: inserta PppoeService espejo con contractId=null.
 *   Si el backend falla → NO hay fila en espejo (sin fantasmas).
 *   Username duplicado en espejo → PppoeUsernameTakenError (409).
 *
 * C2: nasId inexistente → NasNotFoundError; mikrotik_api NAS → router; contrato → delegado
 * C2d/W2: Guard #4 + ensureInternet via delegate
 * W3: upsert puede pisar una fila existente (TOCTOU) → usar createByUsername en standalone path
 */
import { CreatePppoeStandalone } from '@application/use-cases/CreatePppoeStandalone';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import {
  PppoeUsernameTakenError,
  OrchestratorUnreachableError,
  OrchestratorRejectedError,
  NasNotFoundError,
  PppoeContractAlreadyHasServiceError,
} from '@domain/errors/pppoe';

// NAS IDs from InMemoryNasRepository:
//   '1' → mikrotik_api  (ipAddress: '192.168.1.1', apiPort: 8728)
//   '2' → ubiquiti
//   '3' → radius_orchestrator (ipAddress: '10.0.0.5')
const NAS_RADIUS = '3';     // radius_orchestrator
const NAS_MIKROTIK = '1';   // mikrotik_api — ipAddress '192.168.1.1'
const NAS_MK_IP = '192.168.1.1';

function makeOrchestrator(opts?: ConstructorParameters<typeof InMemoryRadiusOrchestratorGateway>[0]) {
  return new InMemoryRadiusOrchestratorGateway(opts);
}

/** Setup básico: standalone path sin delegate (no contractId). */
function setup(orchOpts?: ConstructorParameters<typeof InMemoryRadiusOrchestratorGateway>[0]) {
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const orchestrator = makeOrchestrator(orchOpts);
  const nasRepo = new InMemoryNasRepository();
  const router = new InMemoryRouterGateway();
  const useCase = new CreatePppoeStandalone(pppoeRepo, orchestrator, nasRepo, router);
  return { pppoeRepo, orchestrator, nasRepo, router, useCase };
}

/** Setup con delegate: permite usar contractId (Guard #4 + ensureInternet). */
async function setupWithDelegate(orchOpts?: ConstructorParameters<typeof InMemoryRadiusOrchestratorGateway>[0]) {
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const orchestrator = makeOrchestrator(orchOpts);
  const nasRepo = new InMemoryNasRepository();
  const router = new InMemoryRouterGateway();
  const csRepo = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  await catalogRepo.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });
  const eventRepo = new InMemoryContractServiceEventRepository();
  const ensure = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);
  const delegate = new CreatePppoeService(pppoeRepo, router, nasRepo, orchestrator, ensure);
  const useCase = new CreatePppoeStandalone(pppoeRepo, orchestrator, nasRepo, router, delegate);
  return { pppoeRepo, orchestrator, nasRepo, router, csRepo, eventRepo, useCase };
}

// ── Tests originales (actualizados con nasId válido) ─────────────────────────

describe('CreatePppoeStandalone — happy path sin contrato', () => {
  it('crea sin contrato: orchestrator.createUser llamado, espejo con contractId=null', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();

    const dto = await useCase.execute({
      username: 'testuser',
      password: 'pass123',
      plan: 'IP-10-5',
      nasId: NAS_RADIUS,
    });

    // orchestrator recibió el alta
    expect(orchestrator.createdUser('testuser')).toBeDefined();
    expect(orchestrator.createdUser('testuser')!.plan).toBe('IP-10-5');

    // espejo creado
    const espejo = await pppoeRepo.findByUsername('testuser');
    expect(espejo).not.toBeNull();
    expect(espejo!.contractId).toBeNull();
    expect(espejo!.nasId).toBe(NAS_RADIUS);

    expect(dto.username).toBe('testuser');
    expect(dto.contractId).toBeNull();
  });

  it('crea con framedIp: orchestrator recibe framedIp', async () => {
    const { orchestrator, useCase } = setup();

    await useCase.execute({
      username: 'ipfixed',
      password: 'pass',
      plan: 'IP-10-5',
      nasId: NAS_RADIUS,
      framedIp: '100.64.1.50',
    });

    expect(orchestrator.createdUser('ipfixed')!.framedIp).toBe('100.64.1.50');
  });

  it('ipMode=fixed pasado al espejo', async () => {
    const { pppoeRepo, useCase } = setup();
    await useCase.execute({ username: 'fixed', password: 'p', plan: 'P1', nasId: NAS_RADIUS, ipMode: 'fixed', framedIp: '10.0.0.1' });
    const espejo = await pppoeRepo.findByUsername('fixed');
    expect(espejo!.ipMode).toBe('fixed');
  });
});

describe('CreatePppoeStandalone — validaciones de username', () => {
  it('username duplicado en espejo → PppoeUsernameTakenError, sin crear nada', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();
    // pre-seed el username (nasId puede ser cualquiera — el check de username va antes del NAS check)
    await pppoeRepo.upsertByUsername({ username: 'dupeuser', password: 'old', nasId: 'any', contractId: null });

    await expect(useCase.execute({ username: 'dupeuser', password: 'new', plan: 'P1', nasId: NAS_RADIUS }))
      .rejects.toBeInstanceOf(PppoeUsernameTakenError);

    // orchestrator NO fue llamado
    expect(orchestrator.createdUser('dupeuser')).toBeUndefined();
  });

  it('orchestrator rechaza (OrchestratorRejectedError 409) → NO se inserta fila, se propaga el error', async () => {
    const { pppoeRepo, orchestrator, useCase } = setup();
    // Sembrar 'orchdupe' en el orchestrator para que el createUser falle con 409
    await orchestrator.createUser({ username: 'orchdupe', password: 'x', plan: 'P1' });

    await expect(useCase.execute({ username: 'orchdupe', password: 'new', plan: 'P2', nasId: NAS_RADIUS }))
      .rejects.toBeInstanceOf(OrchestratorRejectedError);

    // espejo NO tiene la fila
    const espejo = await pppoeRepo.findByUsername('orchdupe');
    expect(espejo).toBeNull();
  });

  it('orchestrator inalcanzable → NO se inserta fila (OrchestratorUnreachableError propagado)', async () => {
    const { pppoeRepo, useCase } = setup({ unreachable: ['failuser'] });

    await expect(useCase.execute({ username: 'failuser', password: 'x', plan: 'P1', nasId: NAS_RADIUS }))
      .rejects.toBeInstanceOf(OrchestratorUnreachableError);

    const espejo = await pppoeRepo.findByUsername('failuser');
    expect(espejo).toBeNull();
  });
});

// ── C2: NAS validation + routing ─────────────────────────────────────────────

describe('CreatePppoeStandalone — C2: NAS validation + routing', () => {
  it('C2a — nasId inexistente → NasNotFoundError, sin secret en orchestrator', async () => {
    const { orchestrator, useCase } = setup();

    await expect(useCase.execute({
      username: 'anyuser',
      password: 'p',
      plan: 'P1',
      nasId: 'nonexistent-nas',
    })).rejects.toBeInstanceOf(NasNotFoundError);

    // orchestrator NO fue tocado
    expect(orchestrator.calls.filter(c => c.op === 'createUser')).toHaveLength(0);
  });

  it('C2b — NAS mikrotik_api → crea via router.createSecret, NO via orchestrator', async () => {
    const { pppoeRepo, orchestrator, router, useCase } = setup();

    await useCase.execute({
      username: 'mkuser',
      password: 'pass',
      plan: 'IP-10-5',
      nasId: NAS_MIKROTIK,  // mikrotik_api
    });

    // orchestrator NO fue llamado
    expect(orchestrator.calls.filter(c => c.op === 'createUser')).toHaveLength(0);
    // router SÍ fue llamado: listSecrets para verificar
    const secrets = await router.listSecrets({ ipAddress: NAS_MK_IP, apiPort: 8728 });
    const created = secrets.find(s => s.username === 'mkuser');
    expect(created).toBeDefined();

    // espejo fue creado
    const espejo = await pppoeRepo.findByUsername('mkuser');
    expect(espejo).not.toBeNull();
    expect(espejo!.nasId).toBe(NAS_MIKROTIK);
  });

  it('C2c — NAS radius_orchestrator → crea via orchestrator, NO via router', async () => {
    const { pppoeRepo, orchestrator, router, useCase } = setup();

    await useCase.execute({
      username: 'radiususer',
      password: 'pass',
      plan: 'IP-10-5',
      nasId: NAS_RADIUS,  // radius_orchestrator
    });

    expect(orchestrator.createdUser('radiususer')).toBeDefined();
    // router NO fue llamado con ese username
    const secrets = await router.listSecrets({ ipAddress: NAS_MK_IP, apiPort: 8728 });
    expect(secrets.find(s => s.username === 'radiususer')).toBeUndefined();

    const espejo = await pppoeRepo.findByUsername('radiususer');
    expect(espejo!.nasId).toBe(NAS_RADIUS);
  });
});

// ── C2d/W2: contractId → Guard #4 + ensureInternet ───────────────────────────

describe('CreatePppoeStandalone — C2d: contractId con delegate (Guard #4 + activación)', () => {
  it('C2d-a — contractId que YA tiene PPPoE enabled → PppoeContractAlreadyHasServiceError', async () => {
    const { pppoeRepo, orchestrator, useCase } = await setupWithDelegate();

    // Sembrar un PPPoE enabled para el mismo contrato
    await pppoeRepo.upsertByUsername({
      username: 'existing-svc',
      password: 'p',
      profile: 'P1',
      nasId: NAS_RADIUS,
      contractId: 'ct-taken',
      status: 'enabled',
    });

    await expect(useCase.execute({
      username: 'new-svc',
      password: 'p',
      plan: 'P1',
      nasId: NAS_RADIUS,
      contractId: 'ct-taken',
    })).rejects.toBeInstanceOf(PppoeContractAlreadyHasServiceError);

    // orchestrator NO creó nada nuevo
    expect(orchestrator.createdUser('new-svc')).toBeUndefined();
  });

  it('C2d-b — contractId válido vacío → PPPoE creado + internet line activada', async () => {
    const { pppoeRepo, orchestrator, csRepo, useCase } = await setupWithDelegate();

    const result = await useCase.execute({
      username: 'new-with-ct',
      password: 'pass',
      plan: 'IP-10-5',
      nasId: NAS_RADIUS,
      contractId: 'ct-fresh',
    });

    // PPPoE creado con contractId correcto
    expect(result.username).toBe('new-with-ct');
    expect(result.contractId).toBe('ct-fresh');

    // orchestrator recibió el alta
    expect(orchestrator.createdUser('new-with-ct')).toBeDefined();

    // La línea INTERNET fue activada (ensureInternet llamado)
    const services = await csRepo.listByContract('ct-fresh');
    expect(services.length).toBeGreaterThan(0);
    expect(services.some(s => s.status === 'active')).toBe(true);
  });

  it('C2d-c — sin contractId: espejo con contractId=null (standalone path)', async () => {
    const { pppoeRepo, useCase } = await setupWithDelegate();

    await useCase.execute({
      username: 'standalone',
      password: 'pass',
      plan: 'IP-10-5',
      nasId: NAS_RADIUS,
      // sin contractId
    });

    const espejo = await pppoeRepo.findByUsername('standalone');
    expect(espejo!.contractId).toBeNull();
  });
});

// ── W3: TOCTOU — upsert puede pisar una fila existente ───────────────────────

describe('CreatePppoeStandalone — W3: TOCTOU en standalone path', () => {
  it('W3 — createByUsername rechaza si el username ya existe en el espejo (no sobreescribir)', async () => {
    // Simula el caso de carrera: el username es aprobado en el check inicial, pero
    // para cuando llegamos a persistir, otra petición ya creó el row en el espejo.
    // Testeamos directamente en el repo (la lógica que debe usar el use case):
    const { pppoeRepo } = setup();

    // Sembrar el username
    await pppoeRepo.upsertByUsername({ username: 'race-user', password: 'p', nasId: 'n', contractId: null });

    // createByUsername debe rechazar — no sobreescribir silenciosamente
    await expect(pppoeRepo.createByUsername({ username: 'race-user', password: 'q', nasId: 'm', contractId: null }))
      .rejects.toBeInstanceOf(PppoeUsernameTakenError);
  });

  it('W3 — standalone path usa createByUsername: race condition detectable vía orchestrator + seed', async () => {
    // El use case llama createByUsername (no upsert) después de crear el secret.
    // Si otro request sembró el username entre el check y el persist, el error se propaga.
    const { pppoeRepo, orchestrator, useCase } = setup();

    // Monkey-patch orchestrator.createUser para simular la race condition:
    // después de crear en RADIUS, otro request inserta el mismo username en el espejo
    const originalCreate = orchestrator.createUser.bind(orchestrator);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (orchestrator as any).createUser = async (input: any) => {
      await originalCreate(input);
      // Simular condición de carrera: otra petición persistió el mismo username
      await pppoeRepo.upsertByUsername({
        username: input.username as string,
        password: 'other-req',
        nasId: 'some-other-nas',
        contractId: 'ct-other',
      });
    };

    await expect(useCase.execute({
      username: 'race-user',
      password: 'p',
      plan: 'P1',
      nasId: NAS_RADIUS,
    })).rejects.toBeInstanceOf(PppoeUsernameTakenError);
  });
});

// ── W3: actor forwarded al delegate ──────────────────────────────────────────

describe('CreatePppoeStandalone — W3: actor forwarded al delegate (evento activated con actorName)', () => {
  it('W3 — execute(input, actor) forwardea actor a delegate; evento activated tiene actorName', async () => {
    const { pppoeRepo, eventRepo, useCase } = await setupWithDelegate();

    const actor = { actorId: 'U-99', actorName: 'Encargado' };

    await useCase.execute({
      username:   'w3user',
      password:   'pass',
      plan:       'IP-10-5',
      nasId:      NAS_RADIUS,
      contractId: 'ct-w3',
    }, actor);

    // El evento 'activated' fue registrado con el actorName correcto
    const events = eventRepo.all().filter(e => e.contractId === 'ct-w3');
    const activatedEvent = events.find(e => e.eventType === 'activated');
    expect(activatedEvent).toBeDefined();
    expect(activatedEvent!.actorName).toBe('Encargado');
  });

  it('W3 — sin actor: evento activated tiene actorName vacío (comportamiento legacy)', async () => {
    const { pppoeRepo, eventRepo, useCase } = await setupWithDelegate();

    await useCase.execute({
      username:   'w3-noactor',
      password:   'pass',
      plan:       'IP-10-5',
      nasId:      NAS_RADIUS,
      contractId: 'ct-w3-noactor',
    });
    // sin actor 2do arg

    const events = eventRepo.all().filter(e => e.contractId === 'ct-w3-noactor');
    const activatedEvent = events.find(e => e.eventType === 'activated');
    expect(activatedEvent).toBeDefined();
    expect(activatedEvent!.actorName).toBe('');
  });
});
