/**
 * service-transfer Wave 2 — TransferPppoe unit tests (in-memory, NUNCA Prisma).
 *
 * TDD: escrito ANTES de la implementación.
 *
 * Diseño (design.md §3):
 *  - Guardas comunes (pinned): pppoe existe (404) → targetContract existe+clientId (404) →
 *    target ≠ contrato actual (409 PppoeAlreadyAssociatedError, reuso semántico: "ya está
 *    asociado a ESE contrato") → destino SIN otro PPPoE enabled (espejo associate guard #4).
 *  - mode 'as-is': reason OBLIGATORIO; setContractId (sin tocar RADIUS/router);
 *    ensureInternet(origen,false)+(destino,true) best-effort; eventos transfer-out/in con
 *    notes "tal cual (sin recrear) — pendiente de regularizar".
 *  - mode 'recreate': crear PRIMERO (create falla → abort íntegro, el viejo intacto, cero
 *    eventos), borrar después (terminate falla → partial:true, eventos IGUAL con la marca
 *    del parcial).
 *  - Eventos best-effort: un eventRepo roto NUNCA aborta la transferencia ya hecha.
 */
import { TransferPppoe } from '@application/use-cases/TransferPppoe';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { TerminatePppoeService } from '@application/use-cases/TerminatePppoeService';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import {
  PppoeServiceNotFoundError,
  PppoeAlreadyAssociatedError,
  PppoeContractAlreadyHasServiceError,
  PppoeTransferValidationError,
  PppoeTransferPendingResidueError,
  PppoeUsernameTakenError,
  OrchestratorUnreachableError,
} from '@domain/errors/pppoe';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import type { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';

// NAS '3' del InMemoryNasRepository = radius_orchestrator (el recreate rutea por el orchestrator).
const RADIUS_NAS = '3';

const CONTRACTS: Record<string, { clientId: string; clientName: string | null }> = {
  'C-A': { clientId: 'cli-A', clientName: 'Perez Juan' },
  'C-B': { clientId: 'cli-B', clientName: 'Gomez Ana' },
};

function contractLookup(map: typeof CONTRACTS = CONTRACTS) {
  return { findById: async (id: string) => (id in map ? { id, ...map[id]! } : null) };
}

const ACTOR = { actorId: 'op-1', actorName: 'caro' };

interface Ctx {
  pppoeRepo: InMemoryPppoeServiceRepository;
  routerGw: InMemoryRouterGateway;
  orchestrator: InMemoryRadiusOrchestratorGateway;
  csRepo: InMemoryContractServiceRepository;
  catalogRepo: InMemoryServiceCatalogRepository;
  catalogId: string;
  events: InMemoryContractServiceEventRepository;
  ensureInternet: EnsureInternetContractService;
  createPppoe: CreatePppoeService;
  terminatePppoe: TerminatePppoeService;
  uc: TransferPppoe;
  /** PPPoE seed: 'juanp' enabled en C-A (NAS radius). */
  sourceId: string;
}

async function buildCtx(opts: { orchestratorUnreachable?: string[] } = {}): Promise<Ctx> {
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const routerGw = new InMemoryRouterGateway();
  const nasRepo = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway({ unreachable: opts.orchestratorUnreachable ?? [] });
  const csRepo = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const catalog = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
  csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
  const events = new InMemoryContractServiceEventRepository();
  // SIN eventRepo a propósito: events guarda SOLO los transfer-out/in del use case (aserciones limpias).
  const ensureInternet = new EnsureInternetContractService(csRepo, catalogRepo);
  const createPppoe = new CreatePppoeService(pppoeRepo, routerGw, nasRepo, orchestrator, ensureInternet);
  const terminatePppoe = new TerminatePppoeService(pppoeRepo, orchestrator, routerGw, nasRepo, ensureInternet);
  const uc = new TransferPppoe(pppoeRepo, contractLookup(), createPppoe, terminatePppoe, ensureInternet, catalogRepo, events);
  const source = await pppoeRepo.upsertByUsername({
    username: 'juanp', password: 'pw', profile: 'IP-50', nasId: RADIUS_NAS, contractId: 'C-A', status: 'enabled',
  });
  return {
    pppoeRepo, routerGw, orchestrator, csRepo, catalogRepo, catalogId: catalog.id,
    events, ensureInternet, createPppoe, terminatePppoe, uc, sourceId: source.id,
  };
}

const NEW_PPPOE = { username: 'anag', password: 'pw2', profile: 'IP-100', nasId: RADIUS_NAS };

let warnSpy: jest.SpyInstance;
beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warnSpy.mockRestore(); });

/** "Sin efectos": la fila sigue en C-A enabled, cero eventos, cero llamadas RADIUS/router. */
async function expectNoEffects(ctx: Ctx): Promise<void> {
  const row = await ctx.pppoeRepo.findByUsername('juanp');
  expect(row!.contractId).toBe('C-A');
  expect(row!.status).toBe('enabled');
  expect(ctx.events.all()).toHaveLength(0);
  expect(ctx.orchestrator.calls).toHaveLength(0);
}

describe('TransferPppoe — guardas comunes (pinned)', () => {
  it('pppoe inexistente → PppoeServiceNotFoundError', async () => {
    const ctx = await buildCtx();
    await expect(ctx.uc.execute('ghost', { targetContractId: 'C-B', mode: 'as-is', reason: 'x' }))
      .rejects.toBeInstanceOf(PppoeServiceNotFoundError);
  });

  it('contrato destino inexistente → ContractNotFoundError sin efectos', async () => {
    const ctx = await buildCtx();
    const ensureSpy = jest.spyOn(ctx.ensureInternet, 'execute');
    await expect(ctx.uc.execute(ctx.sourceId, { targetContractId: 'ghost', mode: 'as-is', reason: 'x' }))
      .rejects.toBeInstanceOf(ContractNotFoundError);
    await expectNoEffects(ctx);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('destino == contrato actual → PppoeAlreadyAssociatedError (409) sin efectos', async () => {
    // Decisión documentada: se REUSA PppoeAlreadyAssociatedError — "el PPPoE ya está asociado
    // al contrato C-A" describe EXACTAMENTE el no-op de transferirlo a su propio contrato.
    const ctx = await buildCtx();
    const ensureSpy = jest.spyOn(ctx.ensureInternet, 'execute');
    await expect(ctx.uc.execute(ctx.sourceId, { targetContractId: 'C-A', mode: 'as-is', reason: 'x' }))
      .rejects.toBeInstanceOf(PppoeAlreadyAssociatedError);
    await expectNoEffects(ctx);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('destino con PPPoE enabled → PppoeContractAlreadyHasServiceError sin efectos (espejo associate #4)', async () => {
    const ctx = await buildCtx();
    await ctx.pppoeRepo.upsertByUsername({
      username: 'ocupado', password: 'p', nasId: RADIUS_NAS, contractId: 'C-B', status: 'enabled',
    });
    const ensureSpy = jest.spyOn(ctx.ensureInternet, 'execute');
    await expect(ctx.uc.execute(ctx.sourceId, { targetContractId: 'C-B', mode: 'as-is', reason: 'x' }))
      .rejects.toBeInstanceOf(PppoeContractAlreadyHasServiceError);
    const row = await ctx.pppoeRepo.findByUsername('juanp');
    expect(row!.contractId).toBe('C-A');
    expect(ctx.events.all()).toHaveLength(0);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('FIX-4 — destino con PPPoE enabled en modo RECREATE → PppoeContractAlreadyHasServiceError sin efectos (antes solo cubierto en as-is)', async () => {
    // El guard 4 es común a ambos modos y corre ANTES del create: el nuevo PPPoE jamás nace.
    const ctx = await buildCtx();
    await ctx.pppoeRepo.upsertByUsername({
      username: 'ocupado', password: 'p', nasId: RADIUS_NAS, contractId: 'C-B', status: 'enabled',
    });
    await expect(ctx.uc.execute(ctx.sourceId, { targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE }))
      .rejects.toBeInstanceOf(PppoeContractAlreadyHasServiceError);
    // El create NUNCA corrió: ni fila nueva, ni llamadas al orchestrator; el viejo intacto; cero eventos.
    expect(await ctx.pppoeRepo.findByUsername('anag')).toBeNull();
    expect(ctx.orchestrator.calls).toHaveLength(0);
    const row = await ctx.pppoeRepo.findByUsername('juanp');
    expect(row!.contractId).toBe('C-A');
    expect(row!.status).toBe('enabled');
    expect(ctx.events.all()).toHaveLength(0);
  });

  it('destino con PPPoE disabled NO bloquea (solo enabled ocupa el slot)', async () => {
    const ctx = await buildCtx();
    await ctx.pppoeRepo.upsertByUsername({
      username: 'baja-vieja', password: 'p', nasId: RADIUS_NAS, contractId: 'C-B', status: 'disabled',
    });
    const result = await ctx.uc.execute(ctx.sourceId, { targetContractId: 'C-B', mode: 'as-is', reason: 'x' });
    expect(result.newContractId).toBe('C-B');
  });

  it('PPPoE huérfano (sin contrato origen) → PppoeTransferValidationError (para eso existe associate)', async () => {
    // Decisión de margen documentada: transferir exige titularidad ORIGEN; un huérfano se
    // adopta por POST /pppoe/:id/associate, no por transfer.
    const ctx = await buildCtx();
    const orphan = await ctx.pppoeRepo.upsertByUsername({
      username: 'orphan', password: 'p', nasId: RADIUS_NAS, contractId: null,
    });
    await expect(ctx.uc.execute(orphan.id, { targetContractId: 'C-B', mode: 'as-is', reason: 'x' }))
      .rejects.toBeInstanceOf(PppoeTransferValidationError);
    expect(ctx.events.all()).toHaveLength(0);
  });
});

describe('TransferPppoe — mode as-is', () => {
  it('happy: setContractId sin tocar RADIUS/router, ensureInternet(A,false)+(B,true), eventos out/in', async () => {
    const ctx = await buildCtx();
    const ensureSpy = jest.spyOn(ctx.ensureInternet, 'execute');
    const createSecretSpy = jest.spyOn(ctx.routerGw, 'createSecret');
    const removeSecretSpy = jest.spyOn(ctx.routerGw, 'removeSecret');

    const result = await ctx.uc.execute(ctx.sourceId, {
      targetContractId: 'C-B', mode: 'as-is', reason: 'sin acceso a la antena', ...ACTOR,
    });

    expect(result).toEqual({
      mode: 'as-is', oldContractId: 'C-A', newContractId: 'C-B', oldUsername: 'juanp',
    });

    // La fila cambió de contrato; secret/RADIUS intactos.
    const row = await ctx.pppoeRepo.findByUsername('juanp');
    expect(row!.contractId).toBe('C-B');
    expect(row!.status).toBe('enabled');
    expect(ctx.orchestrator.calls).toHaveLength(0); // CERO llamadas al orchestrator
    expect(createSecretSpy).not.toHaveBeenCalled(); // CERO llamadas al router
    expect(removeSecretSpy).not.toHaveBeenCalled();

    // ensureInternet: origen inactivo, destino activo (best-effort, con reason+actor).
    expect(ensureSpy.mock.calls).toEqual([
      ['C-A', false, { reason: 'sin acceso a la antena', actorId: 'op-1', actorName: 'caro' }],
      ['C-B', true, { reason: 'sin acceso a la antena', actorId: 'op-1', actorName: 'caro' }],
    ]);

    // Eventos: transfer-out en el origen, transfer-in en el destino, con la marca "tal cual".
    const all = ctx.events.all();
    expect(all).toHaveLength(2);
    expect(all[0]!.changeKind).toBe('transfer-out');
    expect(all[1]!.changeKind).toBe('transfer-in');
    const out = all[0]!;
    const inn = all[1]!;
    expect(out.contractId).toBe('C-A');
    expect(inn.contractId).toBe('C-B');
    for (const e of [out, inn]) {
      expect(e.eventType).toBe('modified');
      expect(e.serviceCatalogId).toBe(ctx.catalogId);
      expect(e.oldValue).toBe('Perez Juan');
      expect(e.newValue).toBe('Gomez Ana');
      expect(e.reason).toBe('sin acceso a la antena');
      expect(e.notes).toContain('juanp');
      expect(e.notes).toContain('tal cual (sin recrear)');
      expect(e.notes).toContain('pendiente de regularizar');
      expect(e.actorId).toBe('op-1');
      expect(e.actorName).toBe('caro');
    }
  });

  it('sin reason → PppoeTransferValidationError (VALIDATION_ERROR) sin efectos', async () => {
    const ctx = await buildCtx();
    const ensureSpy = jest.spyOn(ctx.ensureInternet, 'execute');
    await expect(ctx.uc.execute(ctx.sourceId, { targetContractId: 'C-B', mode: 'as-is' }))
      .rejects.toBeInstanceOf(PppoeTransferValidationError);
    await expect(ctx.uc.execute(ctx.sourceId, { targetContractId: 'C-B', mode: 'as-is', reason: '   ' }))
      .rejects.toBeInstanceOf(PppoeTransferValidationError);
    await expectNoEffects(ctx);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('lookup sin clientName → los eventos caen al clientId (nunca un evento sin dirección)', async () => {
    const ctx = await buildCtx();
    const uc = new TransferPppoe(
      ctx.pppoeRepo,
      contractLookup({
        'C-A': { clientId: 'cli-A', clientName: null },
        'C-B': { clientId: 'cli-B', clientName: null },
      }),
      ctx.createPppoe, ctx.terminatePppoe, ctx.ensureInternet, ctx.catalogRepo, ctx.events,
    );
    await uc.execute(ctx.sourceId, { targetContractId: 'C-B', mode: 'as-is', reason: 'x' });
    const all = ctx.events.all();
    expect(all[0]!.oldValue).toBe('cli-A');
    expect(all[0]!.newValue).toBe('cli-B');
  });

  it('ensureInternet lanza → la transferencia NO se rompe (best-effort) y los eventos igual se graban', async () => {
    const ctx = await buildCtx();
    const throwingEnsure = {
      execute: async () => { throw new Error('csRepo explotó (simulado)'); },
    } as unknown as EnsureInternetContractService;
    const uc = new TransferPppoe(
      ctx.pppoeRepo, contractLookup(), ctx.createPppoe, ctx.terminatePppoe,
      throwingEnsure, ctx.catalogRepo, ctx.events,
    );
    const result = await uc.execute(ctx.sourceId, { targetContractId: 'C-B', mode: 'as-is', reason: 'x' });
    expect(result.newContractId).toBe('C-B');
    expect((await ctx.pppoeRepo.findByUsername('juanp'))!.contractId).toBe('C-B');
    expect(ctx.events.all()).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('eventRepo lanza → la transferencia NO se rompe (eventos best-effort)', async () => {
    const ctx = await buildCtx();
    const throwingEvents = {
      record: async () => { throw new Error('event db down'); },
    } as unknown as ContractServiceEventRepository;
    const uc = new TransferPppoe(
      ctx.pppoeRepo, contractLookup(), ctx.createPppoe, ctx.terminatePppoe,
      ctx.ensureInternet, ctx.catalogRepo, throwingEvents,
    );
    const result = await uc.execute(ctx.sourceId, { targetContractId: 'C-B', mode: 'as-is', reason: 'x' });
    expect(result.mode).toBe('as-is');
    expect((await ctx.pppoeRepo.findByUsername('juanp'))!.contractId).toBe('C-B');
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('TransferPppoe — mode recreate', () => {
  it('sin newPppoe → PppoeTransferValidationError sin efectos', async () => {
    const ctx = await buildCtx();
    await expect(ctx.uc.execute(ctx.sourceId, { targetContractId: 'C-B', mode: 'recreate' }))
      .rejects.toBeInstanceOf(PppoeTransferValidationError);
    await expectNoEffects(ctx);
  });

  it('happy: crea PRIMERO y borra DESPUÉS (orden verificado), eventos "recreado: viejo → nuevo"', async () => {
    const ctx = await buildCtx();
    const result = await ctx.uc.execute(ctx.sourceId, {
      targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE, ...ACTOR,
    });

    expect(result).toEqual({
      mode: 'recreate', oldContractId: 'C-A', newContractId: 'C-B',
      oldUsername: 'juanp', newUsername: 'anag',
    });
    expect(result.partial).toBeUndefined();

    // ORDEN pinned: createUser(nuevo) ANTES de deleteUser(viejo).
    const ops = ctx.orchestrator.calls.map(c => `${c.op}:${c.username}`);
    const createIdx = ops.indexOf('createUser:anag');
    const deleteIdx = ops.indexOf('deleteUser:juanp');
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(createIdx);

    // El viejo se borró HARD; el nuevo vive enabled en el contrato destino.
    expect(await ctx.pppoeRepo.findByUsername('juanp')).toBeNull();
    const nu = await ctx.pppoeRepo.findByUsername('anag');
    expect(nu!.contractId).toBe('C-B');
    expect(nu!.status).toBe('enabled');

    // Eventos out/in con la nota del recreate.
    const all = ctx.events.all();
    expect(all).toHaveLength(2);
    expect(all[0]!.changeKind).toBe('transfer-out');
    expect(all[0]!.contractId).toBe('C-A');
    expect(all[1]!.changeKind).toBe('transfer-in');
    expect(all[1]!.contractId).toBe('C-B');
    for (const e of all) {
      expect(e.notes).toBe('PPPoE recreado: juanp → anag');
      expect(e.oldValue).toBe('Perez Juan');
      expect(e.newValue).toBe('Gomez Ana');
    }
  });

  it('create falla → propaga, terminate NUNCA llamado, viejo intacto, CERO eventos', async () => {
    const ctx = await buildCtx({ orchestratorUnreachable: ['anag'] });
    await expect(ctx.uc.execute(ctx.sourceId, {
      targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE,
    })).rejects.toBeInstanceOf(OrchestratorUnreachableError);

    // deleteUser jamás corrió; el viejo quedó íntegro; cero eventos de transferencia.
    const ops = ctx.orchestrator.calls.map(c => c.op);
    expect(ops).not.toContain('deleteUser');
    const old = await ctx.pppoeRepo.findByUsername('juanp');
    expect(old!.contractId).toBe('C-A');
    expect(old!.status).toBe('enabled');
    expect(ctx.events.all()).toHaveLength(0);
    // El nuevo NO quedó enabled (a lo sumo la fila 'pending' reintentable de CreatePppoeService).
    const nu = await ctx.pppoeRepo.findByUsername('anag');
    expect(nu?.status).not.toBe('enabled');
  });

  // MEDIUM-4 — recreate parcial: CreatePppoeService deja la fila 'pending' en el destino cuando
  // el aprovisionamiento falla post-upsert. El retry del transfer NO debe dar el 409
  // PPPOE_USERNAME_TAKEN engañoso: debe decir QUÉ pasó y CÓMO recuperar (id de la fila pending).
  it('MEDIUM-4: retry tras create parcial (fila pending en el destino) → PppoeTransferPendingResidueError con el id', async () => {
    const ctx = await buildCtx({ orchestratorUnreachable: ['anag'] });
    await expect(ctx.uc.execute(ctx.sourceId, {
      targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE,
    })).rejects.toBeInstanceOf(OrchestratorUnreachableError);

    // El create parcial dejó la fila 'anag' pending en el contrato destino.
    const pending = await ctx.pppoeRepo.findByUsername('anag');
    expect(pending!.status).toBe('pending');
    expect(pending!.contractId).toBe('C-B');

    // Retry del MISMO transfer: error PROPIO distinguible con el retry direccionado.
    const err: unknown = await ctx.uc.execute(ctx.sourceId, {
      targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE,
    }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PppoeTransferPendingResidueError);
    const residue = err as PppoeTransferPendingResidueError;
    expect(residue.pendingPppoeId).toBe(pending!.id);
    expect(residue.message).toContain(pending!.id);
    expect(residue.message).toContain('anag');
    expect(residue.code).toBe('PPPOE_TRANSFER_PENDING_RESIDUE');
    // El viejo sigue intacto: el retry no tocó nada.
    expect((await ctx.pppoeRepo.findByUsername('juanp'))!.contractId).toBe('C-A');
  });

  it('MEDIUM-4: username tomado por una fila REAL (enabled) sigue dando PPPOE_USERNAME_TAKEN', async () => {
    const ctx = await buildCtx();
    await ctx.pppoeRepo.upsertByUsername({
      username: 'anag', password: 'p', nasId: RADIUS_NAS, contractId: 'C-X', status: 'enabled',
    });
    await expect(ctx.uc.execute(ctx.sourceId, {
      targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE,
    })).rejects.toBeInstanceOf(PppoeUsernameTakenError);
  });

  it('MEDIUM-4: fila pending pero en OTRO contrato (no es residuo nuestro) → PPPOE_USERNAME_TAKEN de siempre', async () => {
    const ctx = await buildCtx();
    await ctx.pppoeRepo.upsertByUsername({
      username: 'anag', password: 'p', nasId: RADIUS_NAS, contractId: 'C-X', status: 'pending',
    });
    await expect(ctx.uc.execute(ctx.sourceId, {
      targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE,
    })).rejects.toBeInstanceOf(PppoeUsernameTakenError);
  });

  it('terminate falla tras create OK → partial:true, nuevo vivo, viejo pendiente, eventos con la marca del parcial', async () => {
    // 'juanp' unreachable en el orchestrator: createUser('anag') OK, deleteUser('juanp') explota.
    const ctx = await buildCtx({ orchestratorUnreachable: ['juanp'] });
    const result = await ctx.uc.execute(ctx.sourceId, {
      targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE, ...ACTOR,
    });

    expect(result.partial).toBe(true);
    expect(result.newUsername).toBe('anag');

    // Nuevo vivo en el destino; viejo SIGUE existiendo (pendiente de borrar por DELETE /pppoe/:id).
    const nu = await ctx.pppoeRepo.findByUsername('anag');
    expect(nu!.contractId).toBe('C-B');
    expect(nu!.status).toBe('enabled');
    const old = await ctx.pppoeRepo.findByUsername('juanp');
    expect(old).not.toBeNull();
    expect(old!.contractId).toBe('C-A');

    // Los eventos se graban IGUAL, con notes que dicen el parcial.
    const all = ctx.events.all();
    expect(all).toHaveLength(2);
    for (const e of all) {
      expect(e.notes).toContain('PPPoE recreado: juanp → anag');
      expect(e.notes).toContain('PARCIAL');
      expect(e.notes).toContain('pendiente de borrar');
    }
    expect(warnSpy).toHaveBeenCalled();
  });
});
