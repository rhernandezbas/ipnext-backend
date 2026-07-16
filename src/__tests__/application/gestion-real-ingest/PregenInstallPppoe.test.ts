/**
 * install-pppoe-pregen (K1) — PregenInstallPppoe: asegura un PPPoE PRE-PROVISIONADO
 * (nasId null = "pendiente de instalación") para el contrato de una instalación
 * ingestada, con credenciales determinísticas (nombre+apellido+contrato / nombre+1234).
 *
 * Reglas:
 *  - Contrato SIN PPPoE (enabled o pending) → crea pre-provisión vía CreatePppoeService
 *    (RADIUS central, framedIp null) → outcome 'created' con las credenciales.
 *  - Contrato CON PPPoE (enabled o pending) → NO duplica → outcome 'existing' con el
 *    username existente (sin clave).
 *  - Si GR trae `pppoeUsername` histórico para el contrato y difiere del generado,
 *    GANA el de GR (es el username real del cliente en el RADIUS legado).
 *  - Username tomado por OTRA fila (huérfano adoptado del inventario) → 'existing'.
 *  - Falla de aprovisionamiento (orchestrator caído) → 'failed', nunca throw
 *    (la tarea del ingest se crea igual, sin bloque de credenciales).
 */
import { PregenInstallPppoe, renderPppoeCredentialsBlock } from '@application/use-cases/PregenInstallPppoe';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { GrContract } from '@domain/entities/gestionReal';

const PROFILE = 'IP-Air-30-10';

function grContract(overrides: Partial<GrContract> & Pick<GrContract, 'grContratoId' | 'grClienteId'>): GrContract {
  return {
    plan: '300MB',
    status: 'Vigente',
    startDate: null,
    address: null,
    lat: null,
    lng: null,
    pppoeUsername: null,
    modificado: null,
    fechaCreacion: null,
    vendedor: null,
    motivoBaja: null,
    raw: {},
    ...overrides,
  };
}

interface Fixture {
  repo: InMemoryPppoeServiceRepository;
  orchestrator: InMemoryRadiusOrchestratorGateway;
  gr: InMemoryGestionRealPort;
  uc: PregenInstallPppoe;
}

function buildFixture(opts?: { orchestratorUnreachableFor?: string[] }): Fixture {
  const repo = new InMemoryPppoeServiceRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway({
    unreachable: opts?.orchestratorUnreachableFor,
  });
  const ensure = new EnsureInternetContractService(
    new InMemoryContractServiceRepository(),
    new InMemoryServiceCatalogRepository(),
  );
  const createPppoe = new CreatePppoeService(
    repo,
    new InMemoryRouterGateway(),
    new InMemoryNasRepository(),
    orchestrator,
    ensure,
  );
  const gr = new InMemoryGestionRealPort();
  const uc = new PregenInstallPppoe(repo, createPppoe, gr);
  return { repo, orchestrator, gr, uc };
}

const INPUT = {
  contractId: 'svc-1',
  grContratoId: '45123',
  grClienteId: 'gr-cli-1',
  clientName: 'HERNANDEZ RONALD',
  profile: PROFILE,
};

describe('PregenInstallPppoe', () => {
  it('contrato sin PPPoE → crea pre-provisión (nasId null) con credenciales determinísticas', async () => {
    const fx = buildFixture();

    const outcome = await fx.uc.execute({ ...INPUT });

    expect(outcome).toEqual({
      status: 'created',
      username: 'ronaldhernandez45123',
      password: 'ronald1234',
    });

    // Fila espejo: pre-provisión pendiente de instalación (derivación nasId === null).
    const row = await fx.repo.findByUsername('ronaldhernandez45123');
    expect(row).not.toBeNull();
    expect(row!.nasId).toBeNull();
    expect(row!.remoteAddress).toBeNull();
    expect(row!.contractId).toBe('svc-1');
    expect(row!.profile).toBe(PROFILE);
    expect(row!.status).toBe('enabled');

    // RADIUS central: alta SIN Framed-IP con el grupo/plan configurado.
    expect(fx.orchestrator.createdUser('ronaldhernandez45123')).toEqual({
      username: 'ronaldhernandez45123',
      password: 'ronald1234',
      plan: PROFILE,
      framedIp: null,
    });
  });

  it('contrato CON PPPoE enabled → NO duplica: outcome existing con el username, sin alta RADIUS', async () => {
    const fx = buildFixture();
    await fx.repo.upsertByUsername({
      username: 'usuario-viejo',
      password: 'p',
      profile: 'P1',
      nasId: 'nas-9',
      contractId: 'svc-1',
      status: 'enabled',
    });

    const outcome = await fx.uc.execute({ ...INPUT });

    expect(outcome).toEqual({ status: 'existing', username: 'usuario-viejo' });
    expect(fx.orchestrator.createdUser('ronaldhernandez45123')).toBeUndefined();
    expect((await fx.repo.findByContract('svc-1'))).toHaveLength(1);
  });

  it('FIX HIGH: contrato CON PPPoE pending (pregen previo fallido) → stale/pending, NUNCA "(ya existente)"', async () => {
    // Una fila 'pending' NUNCA llegó al RADIUS: sus credenciales NO autentican.
    // Presentarla como "existente" mandaría al técnico a campo con credenciales muertas.
    const fx = buildFixture();
    await fx.repo.upsertByUsername({
      username: 'pendiente-viejo',
      password: 'p',
      profile: 'P1',
      nasId: null,
      contractId: 'svc-1',
      status: 'pending',
    });

    const outcome = await fx.uc.execute({ ...INPUT });

    expect(outcome).toEqual({ status: 'stale', username: 'pendiente-viejo', reason: 'pending' });
    // No duplica ni re-aprovisiona por su cuenta (el retry es manual, página PPPoE).
    expect(fx.orchestrator.createdUser('ronaldhernandez45123')).toBeUndefined();
    expect(await fx.repo.findByContract('svc-1')).toHaveLength(1);
  });

  it('FIX HIGH: username tomado por una fila DISABLED (baja soft) → stale/disabled, jamás "(ya existente)"', async () => {
    // Reinstalación de un contrato dado de baja: el username determinístico colisiona
    // con la fila disabled (la baja conserva el username). Ese usuario está suspendido
    // o ausente del RADIUS — sus credenciales NO sirven para instalar.
    const fx = buildFixture();
    await fx.repo.upsertByUsername({
      username: 'ronaldhernandez45123',
      password: 'clave-de-la-baja',
      profile: 'P1',
      nasId: 'nas-3',
      contractId: 'svc-1',
      status: 'disabled',
    });

    const outcome = await fx.uc.execute({ ...INPUT });

    expect(outcome).toEqual({
      status: 'stale',
      username: 'ronaldhernandez45123',
      reason: 'disabled',
    });
    // La fila de la baja NO fue pisada ni re-aprovisionada.
    const row = await fx.repo.findByUsername('ronaldhernandez45123');
    expect(row!.status).toBe('disabled');
    expect(row!.password).toBe('clave-de-la-baja');
    expect(fx.orchestrator.createdUser('ronaldhernandez45123')).toBeUndefined();
  });

  it('FIX HIGH: username tomado por una fila PENDING ajena → stale/pending', async () => {
    const fx = buildFixture();
    await fx.repo.upsertByUsername({
      username: 'ronaldhernandez45123',
      password: 'p',
      profile: 'P1',
      nasId: null,
      contractId: 'otro-contrato',
      status: 'pending',
    });

    const outcome = await fx.uc.execute({ ...INPUT });

    expect(outcome).toEqual({
      status: 'stale',
      username: 'ronaldhernandez45123',
      reason: 'pending',
    });
  });

  it('GR trae pppoeUsername histórico distinto → GANA el de GR; la clave sigue siendo la generada', async () => {
    const fx = buildFixture();
    fx.gr.contractsByClient['gr-cli-1'] = [
      grContract({ grContratoId: '45123', grClienteId: 'gr-cli-1', pppoeUsername: 'nodo7-ronald' }),
    ];

    const outcome = await fx.uc.execute({ ...INPUT });

    expect(outcome).toEqual({
      status: 'created',
      username: 'nodo7-ronald',
      password: 'ronald1234',
    });
    expect(fx.orchestrator.createdUser('nodo7-ronald')).toMatchObject({
      username: 'nodo7-ronald',
      plan: PROFILE,
      framedIp: null,
    });
    expect(fx.orchestrator.createdUser('ronaldhernandez45123')).toBeUndefined();
  });

  it('GR sin pppoeUsername (null/blank) → usa el generado', async () => {
    const fx = buildFixture();
    fx.gr.contractsByClient['gr-cli-1'] = [
      grContract({ grContratoId: '45123', grClienteId: 'gr-cli-1', pppoeUsername: '   ' }),
    ];

    const outcome = await fx.uc.execute({ ...INPUT });

    expect(outcome).toMatchObject({ status: 'created', username: 'ronaldhernandez45123' });
  });

  it('la consulta a GR es best-effort: si explota, cae al username generado (created igual)', async () => {
    const fx = buildFixture();
    fx.gr.fetchContractsByClient = async () => {
      throw new Error('GR timeout');
    };

    const outcome = await fx.uc.execute({ ...INPUT });

    expect(outcome).toEqual({
      status: 'created',
      username: 'ronaldhernandez45123',
      password: 'ronald1234',
    });
  });

  it('username tomado por OTRA fila (huérfano del inventario) → existing con ese username, sin duplicar', async () => {
    const fx = buildFixture();
    // Huérfano adoptado del RADIUS con el MISMO username que generaríamos (sin contrato).
    await fx.repo.upsertByUsername({
      username: 'ronaldhernandez45123',
      password: 'clave-real-del-radius',
      profile: 'P1',
      nasId: 'nas-3',
      contractId: null,
      status: 'enabled',
    });

    const outcome = await fx.uc.execute({ ...INPUT });

    expect(outcome).toEqual({ status: 'existing', username: 'ronaldhernandez45123' });
    // La fila del huérfano NO fue pisada (la password original sobrevive).
    const row = await fx.repo.findByUsername('ronaldhernandez45123');
    expect(row!.password).toBe('clave-real-del-radius');
  });

  it('orchestrator caído → outcome failed, sin throw (la tarea del ingest sigue)', async () => {
    const fx = buildFixture({ orchestratorUnreachableFor: ['ronaldhernandez45123'] });

    const outcome = await fx.uc.execute({ ...INPUT });

    expect(outcome).toEqual({ status: 'failed' });
    // CreatePppoeService deja la fila 'pending' (visible/reintentable) — contrato intacto.
    // Acá la password generada es LEGÍTIMA (el usuario no existe en el RADIUS todavía):
    // el retry manual re-aprovisiona con esa misma clave.
    const row = await fx.repo.findByUsername('ronaldhernandez45123');
    expect(row?.status).toBe('pending');
  });

  it('FIX MEDIUM: 409 del orchestrator (usuario vivo en el RADIUS, ausente del espejo) → stale/radius-desync y BORRA la fila espejo envenenada', async () => {
    const fx = buildFixture();
    // El usuario YA existe en el RADIUS central con su password real, pero el espejo no lo conoce.
    await fx.orchestrator.createUser({
      username: 'ronaldhernandez45123',
      password: 'password-real-del-radius',
      plan: 'IP-Air-30-10',
      framedIp: null,
    });

    const outcome = await fx.uc.execute({ ...INPUT });

    expect(outcome).toEqual({
      status: 'stale',
      username: 'ronaldhernandez45123',
      reason: 'radius-desync',
    });
    // La fila espejo con la password INVENTADA no puede sobrevivir: envenenaría
    // retry/changePassword (ningún flujo posterior debe confiar en esa clave).
    expect(await fx.repo.findByUsername('ronaldhernandez45123')).toBeNull();
    expect(await fx.repo.findByContract('svc-1')).toHaveLength(0);
    // El usuario del RADIUS quedó INTACTO (password real preservada).
    expect(fx.orchestrator.createdUser('ronaldhernandez45123')!.password).toBe(
      'password-real-del-radius',
    );
  });
});

describe('renderPppoeCredentialsBlock', () => {
  it('created → bloque completo con usuario, clave y estado pendiente de instalar', () => {
    const block = renderPppoeCredentialsBlock({
      status: 'created',
      username: 'ronaldhernandez45123',
      password: 'ronald1234',
    });
    expect(block).toBe(
      '── Credenciales PPPoE ──\n' +
        'Usuario: ronaldhernandez45123\n' +
        'Clave: ronald1234\n' +
        'Estado: pendiente de instalar',
    );
  });

  it('existing → bloque con "(ya existente)" y SIN la clave', () => {
    const block = renderPppoeCredentialsBlock({ status: 'existing', username: 'usuario-viejo' });
    expect(block).toBe('── Credenciales PPPoE ──\nUsuario: usuario-viejo (ya existente)');
    expect(block).not.toContain('Clave');
  });

  it('FIX HIGH: stale/disabled → advertencia de BAJA, sin clave y sin "(ya existente)"', () => {
    const block = renderPppoeCredentialsBlock({
      status: 'stale',
      username: 'user-baja',
      reason: 'disabled',
    });
    expect(block).toBe(
      '── Credenciales PPPoE ──\n' +
        'Usuario: user-baja\n' +
        '⚠ Usuario previo dado de BAJA (estado disabled) — REVISAR en la página PPPoE antes de instalar',
    );
    expect(block).not.toContain('Clave');
    expect(block).not.toContain('ya existente');
  });

  it('FIX HIGH: stale/pending → advertencia de aprovisionamiento pendiente, sin clave', () => {
    const block = renderPppoeCredentialsBlock({
      status: 'stale',
      username: 'user-pend',
      reason: 'pending',
    });
    expect(block).toBe(
      '── Credenciales PPPoE ──\n' +
        'Usuario: user-pend\n' +
        '⚠ Aprovisionamiento previo PENDIENTE (no llegó al RADIUS) — reintentar desde la página PPPoE',
    );
    expect(block).not.toContain('Clave');
    expect(block).not.toContain('ya existente');
  });

  it('FIX MEDIUM: stale/radius-desync → advertencia de usuario ya existente en el RADIUS central', () => {
    const block = renderPppoeCredentialsBlock({
      status: 'stale',
      username: 'user-desync',
      reason: 'radius-desync',
    });
    expect(block).toBe(
      '── Credenciales PPPoE ──\n' +
        'Usuario: user-desync\n' +
        '⚠ El usuario ya existe en el RADIUS central — verificar credenciales manualmente',
    );
    expect(block).not.toContain('Clave');
  });

  it('failed → null (sin bloque)', () => {
    expect(renderPppoeCredentialsBlock({ status: 'failed' })).toBeNull();
  });
});
