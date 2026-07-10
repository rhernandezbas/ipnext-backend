/**
 * actions-worklist W2 — route integration tests for /api/actions.
 * Seam COMPLETO: use cases REALES + adapters in-memory + errorHandler REAL
 * (el mapeo error→status se ejercita contra la misma pieza que corre en prod).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { createActionsRouter } from '../infrastructure/http/routes/actions.routes';
import { errorHandler } from '../infrastructure/http/middleware/errorHandler';
import { ListOwnershipCases } from '../application/use-cases/actions/ListOwnershipCases';
import { UpdateOwnershipCase } from '../application/use-cases/actions/UpdateOwnershipCase';
import { ListRecentBajas } from '../application/use-cases/actions/ListRecentBajas';
import { InMemoryOwnershipCaseRepository } from '../infrastructure/adapters/in-memory/InMemoryOwnershipCaseRepository';
import { InMemoryClientTvCancellationRepository } from '../infrastructure/adapters/in-memory/InMemoryClientTvCancellationRepository';
import { InMemoryContractServiceRepository } from '../infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '../infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryPppoeServiceRepository } from '../infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryContractInventoryRepository } from '../infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemoryContractPairingReader } from '../infrastructure/adapters/in-memory/InMemoryContractPairingReader';
import { InMemoryRetirementOrderReader } from '../infrastructure/adapters/in-memory/InMemoryRetirementOrderReader';
import { OwnershipTransferCase, PairingContract } from '../domain/entities/ownershipCase';
import { OwnershipCaseListFilter, OwnershipCaseListResult } from '../domain/ports/OwnershipCaseRepository';

// ─── Auth + RBAC mock helpers ─────────────────────────────────────────────────

const allowAuth = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: 'user-test', email: 'test@test.com' };
  next();
};

const denyPerm: RequestHandler = (_req, res, _next) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
};

const allowPerm: RequestHandler = (_req, _res, next) => next();

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

function makeBaja(id: string, clientId: string, overrides: Partial<PairingContract> = {}): PairingContract {
  return {
    id,
    clientId,
    address: 'MITRE 100',
    startDate: '2024-05-01T00:00:00.000Z',
    motivoBaja: 'MUDANZA',
    status: 'baja',
    ...overrides,
  };
}

// ─── App factory (seam completo) ──────────────────────────────────────────────

interface BuildAppOptions {
  readPerm?: RequestHandler;
  managePerm?: RequestHandler;
  caseRepo?: InMemoryOwnershipCaseRepository;
}

function buildApp(opts: BuildAppOptions = {}) {
  const caseRepo = opts.caseRepo ?? new InMemoryOwnershipCaseRepository();
  const tvCancellation = new InMemoryClientTvCancellationRepository();
  const contractServiceRepo = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const inventoryRepo = new InMemoryContractInventoryRepository();
  const pairingReader = new InMemoryContractPairingReader();
  const retirementReader = new InMemoryRetirementOrderReader();
  const clientLookup = { findById: async (id: string) => ({ id, name: `Nombre ${id}` }) };
  const userLookup = { findById: async (id: string) => ({ id, name: `User ${id}` }) };

  const app = express();
  app.use(express.json());
  app.use(
    '/api/actions',
    createActionsRouter(
      new ListOwnershipCases(
        caseRepo, tvCancellation, contractServiceRepo, catalogRepo, pppoeRepo, inventoryRepo, clientLookup, userLookup,
      ),
      // El pairing reader in-memory satisface ContractOwnershipLookup (getContract) — H1b.
      new UpdateOwnershipCase(caseRepo, pairingReader),
      new ListRecentBajas(pairingReader, retirementReader, inventoryRepo, clientLookup),
      allowAuth,
      {
        read: opts.readPerm ?? allowPerm,
        manage: opts.managePerm ?? allowPerm,
      },
    ),
  );
  app.use(errorHandler);

  return { app, caseRepo, pairingReader, retirementReader, tvCancellation, catalogRepo, contractServiceRepo, pppoeRepo, inventoryRepo };
}

// ─── RBAC gates (RBAC-1) ──────────────────────────────────────────────────────

describe('/api/actions — RBAC', () => {
  it('GET /ownership-cases sin actions:read → 403', async () => {
    const { app } = buildApp({ readPerm: denyPerm });
    const res = await request(app).get('/api/actions/ownership-cases');
    expect(res.status).toBe(403);
  });

  it('GET /recent-bajas sin actions:read → 403', async () => {
    const { app } = buildApp({ readPerm: denyPerm });
    const res = await request(app).get('/api/actions/recent-bajas');
    expect(res.status).toBe(403);
  });

  it('PATCH /ownership-cases/:id sin actions:manage → 403 SIN efectos', async () => {
    const { app, caseRepo } = buildApp({ managePerm: denyPerm });
    caseRepo.seedCase(makeCase());

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ equipmentReviewed: true });

    expect(res.status).toBe(403);
    expect((await caseRepo.getById('case-1'))!.equipmentReviewed).toBe(false);
  });
});

// ─── GET /ownership-cases ─────────────────────────────────────────────────────

describe('GET /api/actions/ownership-cases', () => {
  it('200 con lista vacía', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/actions/ownership-cases');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], total: 0 });
  });

  it('200 con el DTO enriquecido (nombres + checks)', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase());

    const res = await request(app).get('/api/actions/ownership-cases?status=pending');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const dto = res.body.items[0];
    expect(dto.sourceClientName).toBe('Nombre cli-src');
    expect(dto.targetClientName).toBe('Nombre cli-tgt');
    expect(dto.checks).toMatchObject({
      tv: null, // sin catálogo TV seedeado → no evaluable
      pppoe: null, // H2: el origen no tiene ningún PppoeService → no aplica
      equipment: { sourceActive: 0, targetActive: 0, reviewed: false },
    });
  });

  it('status inválido en query → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/actions/ownership-cases?status=zombie');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('no cuelga cuando el repo lanza (ROB-1): responde 500 inmediato', async () => {
    class ThrowingListRepo extends InMemoryOwnershipCaseRepository {
      override async list(_filter: OwnershipCaseListFilter): Promise<OwnershipCaseListResult> {
        throw new Error('db down');
      }
    }
    const { app } = buildApp({ caseRepo: new ThrowingListRepo() });

    const res = await request(app).get('/api/actions/ownership-cases');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});

// ─── PATCH /ownership-cases/:id — validaciones 400 ───────────────────────────

describe('PATCH /api/actions/ownership-cases/:id — validación del body union', () => {
  it('body vacío → 400', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase());
    const res = await request(app).patch('/api/actions/ownership-cases/case-1').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('más de un discriminador (equipmentReviewed + status) → 400', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase());
    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ equipmentReviewed: true, status: 'pending' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('equipmentReviewed no booleano → 400', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase());
    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ equipmentReviewed: 'yes' });
    expect(res.status).toBe(400);
  });

  it('targetContractId no-string → 400', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase());
    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ targetContractId: 42 });
    expect(res.status).toBe(400);
  });

  it("status distinto de 'dismissed'/'pending' → 400 (done NO se setea por PATCH)", async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase());
    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ status: 'done' });
    expect(res.status).toBe(400);
  });

  it('dismiss sin reason → 400 SIN efectos', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase());

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ status: 'dismissed' });

    expect(res.status).toBe(400);
    expect((await caseRepo.getById('case-1'))!.status).toBe('pending');
  });
});

// ─── PATCH /ownership-cases/:id — union feliz + errores tipados ──────────────

describe('PATCH /api/actions/ownership-cases/:id — union', () => {
  it('id inexistente → 404 OWNERSHIP_CASE_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch('/api/actions/ownership-cases/nope')
      .send({ equipmentReviewed: true });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OWNERSHIP_CASE_NOT_FOUND');
  });

  it('{equipmentReviewed:true} → 200 con actor (del auth) + fecha persistidos', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase());

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ equipmentReviewed: true });

    expect(res.status).toBe(200);
    expect(res.body.equipmentReviewed).toBe(true);
    expect(res.body.equipmentReviewedById).toBe('user-test');
    expect(res.body.equipmentReviewedAt).toEqual(expect.any(String));
    expect((await caseRepo.getById('case-1'))!.equipmentReviewed).toBe(true);
  });

  it('{targetContractId} sobre caso ambiguous con el id en candidates → 200 pending con target', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase({
      status: 'ambiguous',
      targetContractId: null,
      targetClientId: null,
      candidates: [
        { contractId: 'ct-a', clientId: 'cli-a' },
        { contractId: 'ct-b', clientId: 'cli-b' },
      ],
    }));

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ targetContractId: 'ct-b' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.targetContractId).toBe('ct-b');
    expect(res.body.targetClientId).toBe('cli-b');
  });

  it('pick con contractId FUERA de candidates → 422 INVALID_CANDIDATE_PICK sin efectos', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase({
      status: 'ambiguous',
      targetContractId: null,
      targetClientId: null,
      candidates: [{ contractId: 'ct-a', clientId: 'cli-a' }, { contractId: 'ct-b', clientId: 'cli-b' }],
    }));

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ targetContractId: 'ct-intruso' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_CANDIDATE_PICK');
    const persisted = await caseRepo.getById('case-1');
    expect(persisted!.status).toBe('ambiguous');
    expect(persisted!.targetContractId).toBeNull();
  });

  it('pick sobre un pending con target y SIN candidates → 422', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase()); // pending con target, candidates null

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ targetContractId: 'ct-a' });

    expect(res.status).toBe(422);
  });

  // H1c — re-pick: el pending con candidates acepta corregir la elección.
  it('re-pick sobre un pending con target y candidates → 200 con el nuevo target', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase({
      status: 'pending',
      targetContractId: 'ct-a',
      targetClientId: 'cli-a',
      candidates: [{ contractId: 'ct-a', clientId: 'cli-a' }, { contractId: 'ct-b', clientId: 'cli-b' }],
    }));

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ targetContractId: 'ct-b' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.targetContractId).toBe('ct-b');
    expect(res.body.targetClientId).toBe('cli-b');
  });

  // H1b — set-target: el pending nacido sin candidatos (caso 0-candidatos del
  // detector) acepta un destino validado contra el mirror.
  it('set-target sobre un pending sin target ni candidates → 200 validado contra el mirror', async () => {
    const { app, caseRepo, pairingReader } = buildApp();
    caseRepo.seedCase(makeCase({ targetContractId: null, targetClientId: null, candidates: null }));
    pairingReader.seed({
      id: 'ct-destino', clientId: 'cli-destino', address: 'MITRE 100',
      startDate: '2024-05-01T00:00:00.000Z', motivoBaja: null, status: 'active',
    });

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ targetContractId: 'ct-destino' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.targetContractId).toBe('ct-destino');
    expect(res.body.targetClientId).toBe('cli-destino');
  });

  it('set-target con contrato inexistente / en baja / del mismo cliente → 422 INVALID_TARGET_ASSIGNMENT sin efectos', async () => {
    const { app, caseRepo, pairingReader } = buildApp();
    caseRepo.seedCase(makeCase({ targetContractId: null, targetClientId: null, candidates: null }));
    pairingReader.seed({
      id: 'ct-en-baja', clientId: 'cli-x', address: 'MITRE 100',
      startDate: '2024-05-01T00:00:00.000Z', motivoBaja: 'MUDANZA', status: 'baja',
    });
    pairingReader.seed({
      id: 'ct-propio', clientId: 'cli-src', address: 'MITRE 100',
      startDate: '2024-05-01T00:00:00.000Z', motivoBaja: null, status: 'active',
    });

    for (const target of ['ct-fantasma', 'ct-en-baja', 'ct-propio']) {
      const res = await request(app)
        .patch('/api/actions/ownership-cases/case-1')
        .send({ targetContractId: target });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_TARGET_ASSIGNMENT');
    }
    expect((await caseRepo.getById('case-1'))!.targetContractId).toBeNull();
  });

  it('{status:dismissed, reason} → 200 dismissed con motivo', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase());

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ status: 'dismissed', reason: 'falso positivo' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('dismissed');
    expect(res.body.dismissReason).toBe('falso positivo');
  });

  it('{status:pending} reabre un caso dismissed', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase({ status: 'dismissed', dismissReason: 'error' }));

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ status: 'pending' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.dismissReason).toBeNull();
  });

  it('{status:pending} sobre un caso NO dismissed → 422 INVALID_CASE_TRANSITION', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase()); // pending

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ status: 'pending' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_CASE_TRANSITION');
  });

  // H1d — reopen limpia el target heredado del pick previo.
  it('reopen de un dismissed con candidates y target → 200 ambiguous con target LIMPIO', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase({
      status: 'dismissed',
      dismissReason: 'pick equivocado',
      targetContractId: 'ct-a',
      targetClientId: 'cli-a',
      candidates: [{ contractId: 'ct-a', clientId: 'cli-a' }, { contractId: 'ct-b', clientId: 'cli-b' }],
    }));

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ status: 'pending' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ambiguous');
    expect(res.body.targetContractId).toBeNull();
    expect(res.body.targetClientId).toBeNull();
  });

  // L2 — el check manual solo aplica a casos abiertos (pending/ambiguous).
  it('{equipmentReviewed:true} sobre un caso done → 422 INVALID_CASE_TRANSITION sin efectos', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase({ status: 'done' }));

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ equipmentReviewed: true });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_CASE_TRANSITION');
    expect((await caseRepo.getById('case-1'))!.equipmentReviewed).toBe(false);
  });

  // L3 — un caso done no se descarta.
  it('{status:dismissed} sobre un caso done → 422 INVALID_CASE_TRANSITION sin efectos', async () => {
    const { app, caseRepo } = buildApp();
    caseRepo.seedCase(makeCase({ status: 'done' }));

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ status: 'dismissed', reason: 'no va más' });

    expect(res.status).toBe(422);
    expect((await caseRepo.getById('case-1'))!.status).toBe('done');
  });

  it('no cuelga cuando el repo lanza en el PATCH (ROB-1)', async () => {
    class ThrowingGetRepo extends InMemoryOwnershipCaseRepository {
      override async getById(_id: string): Promise<OwnershipTransferCase | null> {
        throw new Error('db down');
      }
    }
    const { app } = buildApp({ caseRepo: new ThrowingGetRepo() });

    const res = await request(app)
      .patch('/api/actions/ownership-cases/case-1')
      .send({ equipmentReviewed: true });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});

// ─── GET /recent-bajas ────────────────────────────────────────────────────────

describe('GET /api/actions/recent-bajas', () => {
  it('200 con filas computadas: retiro-check + conteo de equipos + nombre', async () => {
    const { app, pairingReader, retirementReader, inventoryRepo } = buildApp();
    pairingReader.seed(makeBaja('ct-1', 'cli-1'));
    pairingReader.seed(makeBaja('ct-titu', 'cli-2', { motivoBaja: 'CAMBIO DE TITULARIDAD' })); // excluida
    retirementReader.seedTask({ id: 'task-1', contractId: 'ct-1', clientId: null, allowsEquipmentRetirement: true });
    await inventoryRepo.create({
      id: 'i1', contractId: 'ct-1', type: 'router', serialNumber: null, mac: null, model: null,
      source: 'MANUAL', sourceTaskId: null, addedByUserId: null, confirmedAt: null, status: 'active',
      notes: null, replacesItemId: null, assetId: null,
      createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
    });

    const res = await request(app).get('/api/actions/recent-bajas');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      contractId: 'ct-1',
      clientId: 'cli-1',
      clientName: 'Nombre cli-1',
      motivoBaja: 'MUDANZA',
      retirementOrder: { exists: true, taskId: 'task-1' },
      activeEquipmentCount: 1,
    });
  });

  it('pagina con echo de page/pageSize', async () => {
    const { app, pairingReader } = buildApp();
    pairingReader.seed(makeBaja('ct-1', 'cli-1'));
    pairingReader.seed(makeBaja('ct-2', 'cli-1'));
    pairingReader.seed(makeBaja('ct-3', 'cli-1'));

    const res = await request(app).get('/api/actions/recent-bajas?page=2&pageSize=2');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(2);
  });
});
