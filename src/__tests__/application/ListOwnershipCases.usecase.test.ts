/**
 * actions-worklist W2 — CASE-1: checks AUTO computados contra el estado real.
 * Unit tests con adapters in-memory (jamás Prisma).
 *
 * Semántica H2 (fix wave): null = "no evaluable O no aplica" (el FE muestra "—").
 *   tv    = null sin target, sin catálogo TV, o si el ORIGEN no tiene rastro de TV
 *           (ni severed ni fila TV activa). 'pending' solo cuando HAY TV que
 *           transferir. 'ok' = severed + fila activa en el destino.
 *   pppoe = null sin target o si el ORIGEN no tiene NINGÚN PppoeService.
 * Flip a done (M1): CAS vía flipToDone — pending + reviewed + tv!=='pending' +
 * pppoe!=='pending' (los n/a NO bloquean).
 */
import { ListOwnershipCases } from '@application/use-cases/actions/ListOwnershipCases';
import { InMemoryOwnershipCaseRepository } from '@infrastructure/adapters/in-memory/InMemoryOwnershipCaseRepository';
import { InMemoryClientTvCancellationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvCancellationRepository';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { OwnershipTransferCase } from '@domain/entities/ownershipCase';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCase(overrides: Partial<OwnershipTransferCase> = {}): OwnershipTransferCase {
  return {
    id: 'case-1',
    sourceContractId: 'ct-src',
    sourceClientId: 'cli-src',
    motivoBaja: 'CAMBIO DE TITULARIDAD',
    bajaDate: null,
    targetContractId: 'ct-tgt',
    targetClientId: 'cli-tgt',
    candidates: null,
    status: 'pending',
    dismissReason: null,
    equipmentReviewed: false,
    equipmentReviewedById: null,
    equipmentReviewedAt: null,
    detectedAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function item(id: string, contractId: string, status: 'active' | 'removed' = 'active'): ContractInstalledItem {
  return {
    id,
    contractId,
    type: 'router',
    serialNumber: null,
    mac: null,
    model: null,
    source: 'MANUAL',
    sourceTaskId: null,
    addedByUserId: null,
    confirmedAt: null,
    status,
    notes: null,
    replacesItemId: null,
    assetId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

const CLIENT_NAMES: Record<string, string> = {
  'cli-src': 'Juan Saliente',
  'cli-tgt': 'Ana Entrante',
  'cli-a': 'Candidato A',
  'cli-b': 'Candidato B',
};

const clientLookup = {
  findById: async (id: string) =>
    CLIENT_NAMES[id] !== undefined ? { id, name: CLIENT_NAMES[id] } : null,
};

const userLookup = {
  findById: async (id: string) =>
    id === 'user-1' ? { id, name: 'Operador Uno' } : null,
};

function build(caseRepo?: InMemoryOwnershipCaseRepository) {
  const repo = caseRepo ?? new InMemoryOwnershipCaseRepository();
  const tvCancellation = new InMemoryClientTvCancellationRepository();
  const contractServiceRepo = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const inventoryRepo = new InMemoryContractInventoryRepository();
  const useCase = new ListOwnershipCases(
    repo,
    tvCancellation,
    contractServiceRepo,
    catalogRepo,
    pppoeRepo,
    inventoryRepo,
    clientLookup,
    userLookup,
  );
  return { caseRepo: repo, tvCancellation, contractServiceRepo, catalogRepo, pppoeRepo, inventoryRepo, useCase };
}

/** Seeds the TV catalog + an ACTIVE managed TV row on `contractId`. Returns catalog id. */
async function seedActiveTv(
  catalogRepo: InMemoryServiceCatalogRepository,
  contractServiceRepo: InMemoryContractServiceRepository,
  contractId: string,
): Promise<string> {
  const cats = await catalogRepo.list();
  const cat = cats.find((c) => c.name === 'TV') ?? await catalogRepo.create({ name: 'TV' });
  await contractServiceRepo.add({ contractId, serviceCatalogId: cat.id });
  return cat.id;
}

/** Seeds a PppoeService row on `contractId` (default enabled). */
async function seedPppoe(
  pppoeRepo: InMemoryPppoeServiceRepository,
  contractId: string,
  username: string,
  status: 'enabled' | 'disabled' = 'enabled',
) {
  await pppoeRepo.upsertByUsername({ username, password: 'x', nasId: null, contractId, status });
}

// ─── CASE-1: check TV ─────────────────────────────────────────────────────────

describe('ListOwnershipCases — check TV (CASE-1 / H2)', () => {
  it('tv=ok cuando el titular viejo está severed Y el destino tiene fila TV managed activa', async () => {
    const { caseRepo, tvCancellation, contractServiceRepo, catalogRepo, useCase } = build();
    caseRepo.seedCase(makeCase());
    tvCancellation.seedCancelled('cli-src');
    await seedActiveTv(catalogRepo, contractServiceRepo, 'ct-tgt');

    const result = await useCase.execute({});

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.checks.tv).toBe('ok');
  });

  it('tv=pending cuando el origen AÚN tiene la TV activa (hay TV que transferir) y el destino también tiene fila', async () => {
    const { caseRepo, contractServiceRepo, catalogRepo, useCase } = build();
    caseRepo.seedCase(makeCase());
    await seedActiveTv(catalogRepo, contractServiceRepo, 'ct-src'); // TV viva en el origen
    await seedActiveTv(catalogRepo, contractServiceRepo, 'ct-tgt');

    const result = await useCase.execute({});

    expect(result.items[0]!.checks.tv).toBe('pending');
  });

  it('tv=pending cuando el destino NO tiene fila TV activa (aunque el viejo esté severed)', async () => {
    const { caseRepo, tvCancellation, contractServiceRepo, catalogRepo, useCase } = build();
    caseRepo.seedCase(makeCase());
    tvCancellation.seedCancelled('cli-src');
    const cat = await catalogRepo.create({ name: 'TV' });
    // fila TV en el destino pero INACTIVA
    const row = await contractServiceRepo.add({ contractId: 'ct-tgt', serviceCatalogId: cat.id });
    await contractServiceRepo.update(row.id, { status: 'inactive' });

    const result = await useCase.execute({});

    expect(result.items[0]!.checks.tv).toBe('pending');
  });

  it('tv=null cuando NO existe catálogo TV (check no evaluable)', async () => {
    const { caseRepo, tvCancellation, useCase } = build();
    caseRepo.seedCase(makeCase());
    tvCancellation.seedCancelled('cli-src');

    const result = await useCase.execute({});

    expect(result.items[0]!.checks.tv).toBeNull();
  });

  // H2 — titular viejo SIN TV: ni severed ni fila TV activa en el origen →
  // no hay nada que transferir, el check NO aplica (null, el FE muestra "—").
  it('tv=null cuando el origen NO tiene rastro de TV (ni severed ni fila activa) — no aplica', async () => {
    const { caseRepo, contractServiceRepo, catalogRepo, useCase } = build();
    caseRepo.seedCase(makeCase());
    // catálogo TV existe, y el DESTINO hasta tiene TV propia — pero el ORIGEN no tuvo nunca.
    await seedActiveTv(catalogRepo, contractServiceRepo, 'ct-tgt');

    const result = await useCase.execute({});

    expect(result.items[0]!.checks.tv).toBeNull();
  });

  it('tv=null con fila TV INACTIVA en el origen (rastro muerto no cuenta)', async () => {
    const { caseRepo, contractServiceRepo, catalogRepo, useCase } = build();
    caseRepo.seedCase(makeCase());
    const cat = await catalogRepo.create({ name: 'TV' });
    const row = await contractServiceRepo.add({ contractId: 'ct-src', serviceCatalogId: cat.id });
    await contractServiceRepo.update(row.id, { status: 'inactive' });

    const result = await useCase.execute({});

    expect(result.items[0]!.checks.tv).toBeNull();
  });
});

// ─── CASE-1: checks sin target ────────────────────────────────────────────────

describe('ListOwnershipCases — caso sin target (CASE-1)', () => {
  it('tv y pppoe son null y equipment.targetActive es null', async () => {
    const { caseRepo, catalogRepo, useCase } = build();
    await catalogRepo.create({ name: 'TV' });
    caseRepo.seedCase(makeCase({ targetContractId: null, targetClientId: null }));

    const result = await useCase.execute({});

    const dto = result.items[0]!;
    expect(dto.checks.tv).toBeNull();
    expect(dto.checks.pppoe).toBeNull();
    expect(dto.checks.equipment.targetActive).toBeNull();
    expect(dto.targetClientName).toBeNull();
  });
});

// ─── CASE-1: check PPPoE ──────────────────────────────────────────────────────

describe('ListOwnershipCases — check PPPoE (CASE-1 / H2)', () => {
  it('pppoe=ok cuando el origen tenía PPPoE y existe un PppoeService enabled con contractId = target', async () => {
    const { caseRepo, pppoeRepo, useCase } = build();
    caseRepo.seedCase(makeCase());
    await seedPppoe(pppoeRepo, 'ct-src', 'viejo@titular', 'disabled'); // rastro en el origen
    await seedPppoe(pppoeRepo, 'ct-tgt', 'nuevo@titular', 'enabled');

    const result = await useCase.execute({});

    expect(result.items[0]!.checks.pppoe).toBe('ok');
  });

  it('pppoe=pending cuando el origen tiene PPPoE y el target no tiene enabled (disabled no cuenta)', async () => {
    const { caseRepo, pppoeRepo, useCase } = build();
    caseRepo.seedCase(makeCase());
    await seedPppoe(pppoeRepo, 'ct-src', 'viejo@titular', 'enabled'); // aún vive en el origen
    await seedPppoe(pppoeRepo, 'ct-tgt', 'nuevo@titular', 'disabled');

    const result = await useCase.execute({});

    expect(result.items[0]!.checks.pppoe).toBe('pending');
  });

  // H2 — cliente TV-only: el contrato origen no tiene NINGÚN PppoeService →
  // no hay nada que migrar, el check NO aplica (null).
  it('pppoe=null cuando el contrato ORIGEN no tiene ningún PppoeService — no aplica', async () => {
    const { caseRepo, useCase } = build();
    caseRepo.seedCase(makeCase());

    const result = await useCase.execute({});

    expect(result.items[0]!.checks.pppoe).toBeNull();
  });
});

// ─── CASE-1: equipment ────────────────────────────────────────────────────────

describe('ListOwnershipCases — equipment (CASE-1)', () => {
  it('cuenta SOLO los ítems activos de source y target + expone el manual review con nombre del actor', async () => {
    const { caseRepo, inventoryRepo, useCase } = build();
    caseRepo.seedCase(makeCase({
      equipmentReviewed: true,
      equipmentReviewedById: 'user-1',
      equipmentReviewedAt: '2026-07-05T10:00:00.000Z',
    }));
    await inventoryRepo.create(item('i1', 'ct-src'));
    await inventoryRepo.create(item('i2', 'ct-src'));
    await inventoryRepo.create(item('i3', 'ct-src', 'removed'));
    await inventoryRepo.create(item('i4', 'ct-tgt'));

    const result = await useCase.execute({});

    const eq = result.items[0]!.checks.equipment;
    expect(eq.sourceActive).toBe(2);
    expect(eq.targetActive).toBe(1);
    expect(eq.reviewed).toBe(true);
    expect(eq.reviewedAt).toBe('2026-07-05T10:00:00.000Z');
    expect(eq.reviewedByName).toBe('Operador Uno');
  });

  it('sin review manual: reviewed=false y reviewedAt/reviewedByName null', async () => {
    const { caseRepo, useCase } = build();
    caseRepo.seedCase(makeCase());

    const result = await useCase.execute({});

    const eq = result.items[0]!.checks.equipment;
    expect(eq.reviewed).toBe(false);
    expect(eq.reviewedAt).toBeNull();
    expect(eq.reviewedByName).toBeNull();
  });
});

// ─── CASE-1: nombres enriquecidos ─────────────────────────────────────────────

describe('ListOwnershipCases — DTO con nombres', () => {
  it('resuelve nombres de source/target y de los candidates', async () => {
    const { caseRepo, useCase } = build();
    caseRepo.seedCase(makeCase({
      status: 'ambiguous',
      targetContractId: null,
      targetClientId: null,
      candidates: [
        { contractId: 'ct-a', clientId: 'cli-a' },
        { contractId: 'ct-b', clientId: 'cli-b' },
      ],
    }));

    const result = await useCase.execute({});

    const dto = result.items[0]!;
    expect(dto.sourceClientName).toBe('Juan Saliente');
    expect(dto.candidates).toEqual([
      { contractId: 'ct-a', clientId: 'cli-a', clientName: 'Candidato A' },
      { contractId: 'ct-b', clientId: 'cli-b', clientName: 'Candidato B' },
    ]);
  });

  it('cliente desconocido en el lookup → name null (nunca lanza)', async () => {
    const { caseRepo, useCase } = build();
    caseRepo.seedCase(makeCase({ sourceClientId: 'cli-fantasma', targetClientId: 'cli-fantasma-2' }));

    const result = await useCase.execute({});

    expect(result.items[0]!.sourceClientName).toBeNull();
    expect(result.items[0]!.targetClientName).toBeNull();
  });
});

// ─── CASE-1: flip a done (H2 + M1 CAS) ────────────────────────────────────────

describe('ListOwnershipCases — flip a done (CASE-1 / H2 / M1)', () => {
  async function seedAllOk(deps: ReturnType<typeof build>) {
    deps.caseRepo.seedCase(makeCase({
      equipmentReviewed: true,
      equipmentReviewedById: 'user-1',
      equipmentReviewedAt: '2026-07-05T10:00:00.000Z',
    }));
    deps.tvCancellation.seedCancelled('cli-src');
    await seedActiveTv(deps.catalogRepo, deps.contractServiceRepo, 'ct-tgt');
    await seedPppoe(deps.pppoeRepo, 'ct-src', 'viejo@titular', 'disabled');
    await seedPppoe(deps.pppoeRepo, 'ct-tgt', 'nuevo@titular', 'enabled');
  }

  it('caso pending con tv=ok + pppoe=ok + reviewed → sale done en el DTO y el flip SE PERSISTE', async () => {
    const deps = build();
    await seedAllOk(deps);

    const result = await deps.useCase.execute({});

    expect(result.items[0]!.status).toBe('done');
    const persisted = await deps.caseRepo.getById('case-1');
    expect(persisted!.status).toBe('done');
  });

  // H2 — los "no aplica" NO bloquean el done.
  it('cliente sin TV (tv=null) + pppoe=ok + reviewed → done (el n/a no bloquea)', async () => {
    const deps = build();
    deps.caseRepo.seedCase(makeCase({
      equipmentReviewed: true,
      equipmentReviewedById: 'user-1',
      equipmentReviewedAt: '2026-07-05T10:00:00.000Z',
    }));
    await deps.catalogRepo.create({ name: 'TV' }); // catálogo existe, origen sin rastro de TV
    await seedPppoe(deps.pppoeRepo, 'ct-src', 'viejo@titular', 'disabled');
    await seedPppoe(deps.pppoeRepo, 'ct-tgt', 'nuevo@titular', 'enabled');

    const result = await deps.useCase.execute({});

    expect(result.items[0]!.status).toBe('done');
    expect(result.items[0]!.checks.tv).toBeNull();
    expect((await deps.caseRepo.getById('case-1'))!.status).toBe('done');
  });

  it('cliente TV-only (pppoe=null) + tv=ok + reviewed → done (espejo)', async () => {
    const deps = build();
    deps.caseRepo.seedCase(makeCase({
      equipmentReviewed: true,
      equipmentReviewedById: 'user-1',
      equipmentReviewedAt: '2026-07-05T10:00:00.000Z',
    }));
    deps.tvCancellation.seedCancelled('cli-src');
    await seedActiveTv(deps.catalogRepo, deps.contractServiceRepo, 'ct-tgt');
    // origen SIN PppoeService — nada que migrar

    const result = await deps.useCase.execute({});

    expect(result.items[0]!.status).toBe('done');
    expect(result.items[0]!.checks.pppoe).toBeNull();
  });

  it('caso solo-equipos: tv=null + pppoe=null + reviewed → done', async () => {
    const deps = build();
    deps.caseRepo.seedCase(makeCase({
      equipmentReviewed: true,
      equipmentReviewedById: 'user-1',
      equipmentReviewedAt: '2026-07-05T10:00:00.000Z',
    }));
    // sin catálogo TV y sin PPPoE en el origen — ambos checks n/a

    const result = await deps.useCase.execute({});

    expect(result.items[0]!.status).toBe('done');
    expect(result.items[0]!.checks.tv).toBeNull();
    expect(result.items[0]!.checks.pppoe).toBeNull();
    expect((await deps.caseRepo.getById('case-1'))!.status).toBe('done');
  });

  it('tv=pending BLOQUEA el flip aunque pppoe=ok y reviewed', async () => {
    const deps = build();
    deps.caseRepo.seedCase(makeCase({
      equipmentReviewed: true,
      equipmentReviewedById: 'user-1',
      equipmentReviewedAt: '2026-07-05T10:00:00.000Z',
    }));
    await seedActiveTv(deps.catalogRepo, deps.contractServiceRepo, 'ct-src'); // TV viva en el origen
    await seedPppoe(deps.pppoeRepo, 'ct-src', 'viejo@titular', 'disabled');
    await seedPppoe(deps.pppoeRepo, 'ct-tgt', 'nuevo@titular', 'enabled');

    const result = await deps.useCase.execute({});

    expect(result.items[0]!.checks.tv).toBe('pending');
    expect(result.items[0]!.status).toBe('pending');
    expect((await deps.caseRepo.getById('case-1'))!.status).toBe('pending');
  });

  it('NO flipea si falta el review manual (tv+pppoe ok no alcanzan)', async () => {
    const deps = build();
    deps.caseRepo.seedCase(makeCase());
    deps.tvCancellation.seedCancelled('cli-src');
    await seedActiveTv(deps.catalogRepo, deps.contractServiceRepo, 'ct-tgt');
    await seedPppoe(deps.pppoeRepo, 'ct-src', 'viejo@titular', 'disabled');
    await seedPppoe(deps.pppoeRepo, 'ct-tgt', 'nuevo@titular', 'enabled');

    const result = await deps.useCase.execute({});

    expect(result.items[0]!.status).toBe('pending');
    expect((await deps.caseRepo.getById('case-1'))!.status).toBe('pending');
  });

  // M1 — TOCTOU: un dismiss concurrente entre la lectura y el flip NO se pisa.
  it('CAS: si el caso cambió entre la lectura y el flip (dismiss concurrente), el DTO NO sale done', async () => {
    class ConcurrentDismissRepo extends InMemoryOwnershipCaseRepository {
      override async flipToDone(id: string): Promise<boolean> {
        // Simula la carrera: otro request descartó el caso ANTES del flip.
        await this.update(id, { status: 'dismissed', dismissReason: 'carrera' });
        return super.flipToDone(id); // CAS real: pending ya no matchea → false
      }
    }
    const deps = build(new ConcurrentDismissRepo());
    await seedAllOk(deps);

    const result = await deps.useCase.execute({});

    expect(result.items[0]!.status).toBe('dismissed'); // estado real releído, jamás done
    expect((await deps.caseRepo.getById('case-1'))!.status).toBe('dismissed');
  });

  it('el flip es best-effort: si flipToDone LANZA, el DTO sale done igual y NO propaga', async () => {
    class ThrowingFlipRepo extends InMemoryOwnershipCaseRepository {
      override async flipToDone(_id: string): Promise<boolean> {
        throw new Error('db down');
      }
    }
    const deps = build(new ThrowingFlipRepo());
    await seedAllOk(deps);

    const result = await deps.useCase.execute({});

    expect(result.items[0]!.status).toBe('done');
    // sin persistir (el flip lanzó) — el estado en repo sigue pending
    expect((await deps.caseRepo.getById('case-1'))!.status).toBe('pending');
  });
});

// ─── Filtro + paginación ──────────────────────────────────────────────────────

describe('ListOwnershipCases — filtro y paginación', () => {
  it('filtra por status y pagina con total', async () => {
    const { caseRepo, useCase } = build();
    caseRepo.seedCase(makeCase({ id: 'c1', sourceContractId: 's1' }));
    caseRepo.seedCase(makeCase({ id: 'c2', sourceContractId: 's2' }));
    caseRepo.seedCase(makeCase({ id: 'c3', sourceContractId: 's3', status: 'dismissed', dismissReason: 'error' }));

    const pending = await useCase.execute({ status: 'pending', page: 1, pageSize: 1 });
    expect(pending.total).toBe(2);
    expect(pending.items).toHaveLength(1);
    expect(pending.page).toBe(1);
    expect(pending.pageSize).toBe(1);

    const dismissed = await useCase.execute({ status: 'dismissed' });
    expect(dismissed.total).toBe(1);
    expect(dismissed.items[0]!.id).toBe('c3');
    expect(dismissed.items[0]!.dismissReason).toBe('error');
  });

  // M5 — clamp del paging: el use case es la última línea (la route puede mentir).
  it('pageSize > 100 se clampa a 100', async () => {
    const { useCase } = build();

    const result = await useCase.execute({ pageSize: 500 });

    expect(result.pageSize).toBe(100);
  });

  it('pageSize negativo o NaN cae al default 25', async () => {
    const { useCase } = build();

    expect((await useCase.execute({ pageSize: -5 })).pageSize).toBe(25);
    expect((await useCase.execute({ pageSize: Number.NaN })).pageSize).toBe(25);
  });

  it('page negativa, cero o NaN cae al default 1', async () => {
    const { useCase } = build();

    expect((await useCase.execute({ page: -3 })).page).toBe(1);
    expect((await useCase.execute({ page: 0 })).page).toBe(1);
    expect((await useCase.execute({ page: Number.NaN })).page).toBe(1);
  });
});
