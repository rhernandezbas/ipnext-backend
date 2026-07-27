import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createFinanceGrowthRouter } from '@infrastructure/http/routes/financeGrowth.routes';
import { ListFinanceInvoiceTypes } from '@application/use-cases/finance/ListFinanceInvoiceTypes';
import { ReclassifyFinanceInvoiceType } from '@application/use-cases/finance/ReclassifyFinanceInvoiceType';
import { GetFinanceSyncStatus } from '@application/use-cases/finance/GetFinanceSyncStatus';
import { ForceFinanceDeltaRun } from '@application/use-cases/finance/ForceFinanceDeltaRun';
import { RearmFinanceReceiptsBackfill } from '@application/use-cases/finance/RearmFinanceReceiptsBackfill';
import { InMemoryFinanceInvoiceTypeClassificationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceInvoiceTypeClassificationRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { InMemoryFinanceReceiptSyncConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptSyncConfigRepository';
import { FinanceReceiptIngestScheduler } from '@infrastructure/scheduling/FinanceReceiptIngestScheduler';
// finance-growth Fase 2 — settables CRUD.
import { GetFinanceTechnologyCosts } from '@application/use-cases/finance/GetFinanceTechnologyCosts';
import { UpdateFinanceTechnologyCost } from '@application/use-cases/finance/UpdateFinanceTechnologyCost';
import { GetFinancePlanPrices } from '@application/use-cases/finance/GetFinancePlanPrices';
import { UpdateFinancePlanPrice } from '@application/use-cases/finance/UpdateFinancePlanPrice';
import { GetFinanceTargets } from '@application/use-cases/finance/GetFinanceTargets';
import { UpdateFinanceTargets } from '@application/use-cases/finance/UpdateFinanceTargets';
import { ListFinanceInflationIndex } from '@application/use-cases/finance/ListFinanceInflationIndex';
import { UpdateFinanceInflationIndex } from '@application/use-cases/finance/UpdateFinanceInflationIndex';
import { BackfillFinanceMonthlySnapshots } from '@application/use-cases/finance/BackfillFinanceMonthlySnapshots';
import { InMemoryFinanceTechnologyCostRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceTechnologyCostRepository';
import { InMemoryFinancePlanPriceRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePlanPriceRepository';
import { InMemoryFinanceTargetsConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceTargetsConfigRepository';
import { InMemoryFinanceInflationIndexRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceInflationIndexRepository';
import { InMemoryContractTechnologyRepository } from '@infrastructure/adapters/in-memory/InMemoryContractTechnologyRepository';
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { createAuthMiddleware } from '@infrastructure/http/middleware/authMiddleware';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';

import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

class EchoAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'x', username: 't', email: 't@t.com', role: 'admin' as const },
      cookieValue: 'x',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    return { id: token, username: 'test', email: 'test@test.com', role: 'admin' };
  }
}

async function buildApp(overrides: { rearmBackfill?: RearmFinanceReceiptsBackfill } = {}) {
  // fix-wave-2 R3 — a REAL `FinanceReceiptIngestScheduler` (not a hand-rolled
  // boolean ref) so the 503 guard test below exercises the ACTUAL composition
  // (`isSchedulerRunning: () => scheduler.isEnabled()`), the same expression
  // wired in `app.ts`. Before this fix, the test injected
  // `isSchedulerRunning: () => schedulerRunningRef.value` directly, which
  // proved nothing about whether the real `isEnabled()` logic behaved
  // correctly against a live `FinanceReceiptSyncConfig`.
  const financeSyncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
  const financeSchedulerLock = new InMemoryDistributedLock();
  const noopDelta = { execute: async () => ({ pageProcessed: 0, hasPendingPages: false, coveredThroughDate: null }) };
  const noopBackfill = { execute: async () => ({ pageProcessed: 0, monthAdvanced: false, done: true }) };
  const financeScheduler = new FinanceReceiptIngestScheduler(
    noopDelta,
    noopBackfill,
    new InMemorySyncStateRepository(),
    financeSchedulerLock,
    financeSyncConfig,
    { silent: true },
  );

  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher = new InMemoryPasswordHasher();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  userRepo.listRolesForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const roles = await Promise.all(roleIds.map((id) => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  userRepo.listPermissionsForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const perms: import('@domain/entities/rbac').RbacPermission[] = [];
    const allPerms = await permRepo.listAll();
    for (const roleId of roleIds) {
      const permIds = await rolePermRepo.listForRole(roleId);
      for (const permId of permIds) {
        const p = allPerms.find((ap) => ap.id === permId);
        if (p) perms.push(p);
      }
    }
    return perms;
  };

  const readRole = await roleRepo.create({ code: 'finance_read', label: 'Finance Read', isSystem: false });
  const costsRole = await roleRepo.create({ code: 'finance_costs', label: 'Finance Costs', isSystem: false });
  const syncRole = await roleRepo.create({ code: 'finance_sync', label: 'Finance Sync', isSystem: false });
  const noneRole = await roleRepo.create({ code: 'finance_none', label: 'Finance None', isSystem: false });
  // Fase 2 — dedicated roles for the two OTHER granular actions, so tests can
  // assert `manage_costs` alone does NOT unlock `manage_targets`/`manage_inflation`
  // (spec.md "acción SEPARADA de `manage_costs`").
  const targetsRole = await roleRepo.create({ code: 'finance_targets', label: 'Finance Targets', isSystem: false });
  const inflationRole = await roleRepo.create({ code: 'finance_inflation', label: 'Finance Inflation', isSystem: false });

  const readPerm = await permRepo.seed({ moduleCode: 'finance', action: 'read' });
  const costsPerm = await permRepo.seed({ moduleCode: 'finance', action: 'manage_costs' });
  const syncPerm = await permRepo.seed({ moduleCode: 'finance', action: 'sync' });
  const targetsPerm = await permRepo.seed({ moduleCode: 'finance', action: 'manage_targets' });
  const inflationPerm = await permRepo.seed({ moduleCode: 'finance', action: 'manage_inflation' });
  await rolePermRepo.grant(readRole.id, readPerm.id);
  await rolePermRepo.grant(costsRole.id, costsPerm.id);
  await rolePermRepo.grant(syncRole.id, syncPerm.id);
  await rolePermRepo.grant(targetsRole.id, targetsPerm.id);
  await rolePermRepo.grant(inflationRole.id, inflationPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readRole.id);
  const costsUser = await mkUser('costseditor');
  await userRoleRepo.assign(costsUser.id, costsRole.id);
  const syncUser = await mkUser('syncer');
  await userRoleRepo.assign(syncUser.id, syncRole.id);
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(noPermUser.id, noneRole.id);
  const targetsUser = await mkUser('targetseditor');
  await userRoleRepo.assign(targetsUser.id, targetsRole.id);
  const inflationUser = await mkUser('inflationeditor');
  await userRoleRepo.assign(inflationUser.id, inflationRole.id);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const invoiceTypes = new InMemoryFinanceInvoiceTypeClassificationRepository();
  invoiceTypes.seed('FB', 'revenue', 'Factura B');
  invoiceTypes.seed('XZ', 'unclassified');
  const state = new InMemorySyncStateRepository();

  const listInvoiceTypes = new ListFinanceInvoiceTypes(invoiceTypes);
  const reclassifyInvoiceType = new ReclassifyFinanceInvoiceType(invoiceTypes);
  const getSyncStatus = new GetFinanceSyncStatus(state);
  const lock = new InMemoryDistributedLock();
  const forceDeltaRun = new ForceFinanceDeltaRun(state, lock, { retryDelayMs: 0 });
  const rearmBackfill = overrides.rearmBackfill ?? new RearmFinanceReceiptsBackfill(state, lock, () => new Date('2026-07-15T12:00:00Z'), { retryDelayMs: 0 });

  // Fase 2 — settables CRUD (in-memory, molde el resto de este archivo).
  const technologies = new InMemoryContractTechnologyRepository();
  await technologies.create({ name: 'Fibra', description: null });
  const technologyCosts = new InMemoryFinanceTechnologyCostRepository();
  const getTechnologyCosts = new GetFinanceTechnologyCosts(technologyCosts, technologies);
  // fix-wave-1 D — the catalog is now a REQUIRED collaborator of the Update*
  // use case too (404 guard against a typo'd/renamed technologyName).
  const updateTechnologyCost = new UpdateFinanceTechnologyCost(technologyCosts, technologies);

  const plans = new InMemoryPlanRepository();
  await plans.upsertByCode({ code: 'IP-Fibra-100-50', name: 'Fibra 100/50', category: 'fibra', downloadKbps: 100000, uploadKbps: 50000 });
  const planPrices = new InMemoryFinancePlanPriceRepository();
  const getPlanPrices = new GetFinancePlanPrices(planPrices, plans);
  // fix-wave-1 D — same 404 guard, against the Plan catalog.
  const updatePlanPrice = new UpdateFinancePlanPrice(planPrices, plans);

  const targetsConfig = new InMemoryFinanceTargetsConfigRepository();
  const getTargets = new GetFinanceTargets(targetsConfig);
  const updateTargets = new UpdateFinanceTargets(targetsConfig);

  const inflationIndex = new InMemoryFinanceInflationIndexRepository();
  const listInflationIndex = new ListFinanceInflationIndex(inflationIndex);
  const updateInflationIndex = new UpdateFinanceInflationIndex(inflationIndex);

  // finance-growth Fase 3 rework (J1) — route-level test only needs the
  // guard + shape wiring, not the full metrics engine; a lightweight fake
  // satisfying the `.execute()` contract is enough here (the engine ITSELF
  // is covered exhaustively by BuildFinanceMonthlySnapshot.test.ts).
  const backfillSnapshotsCalls: Array<[string, string]> = [];
  const backfillSnapshots = {
    execute: jest.fn(async (from: string, to: string) => {
      backfillSnapshotsCalls.push([from, to]);
      return { monthsComputed: [from], monthsFailed: [] };
    }),
  } as unknown as BackfillFinanceMonthlySnapshots;

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/finance/growth',
    createFinanceGrowthRouter({
      auth: createAuthMiddleware(new EchoAuthProvider()),
      requirePerm,
      listInvoiceTypes,
      reclassifyInvoiceType,
      getSyncStatus,
      forceDeltaRun,
      rearmBackfill,
      // fix-wave-2 R3 — the SAME expression app.ts wires, against a REAL scheduler.
      isSchedulerRunning: () => financeScheduler.isEnabled(),
      getPacingStatus: () => financeScheduler.status,
      getTechnologyCosts,
      updateTechnologyCost,
      getPlanPrices,
      updatePlanPrice,
      getTargets,
      updateTargets,
      listInflationIndex,
      updateInflationIndex,
      backfillSnapshots,
    }),
  );
  app.use(errorHandler);

  return {
    app,
    invoiceTypes,
    state,
    financeScheduler,
    financeSyncConfig,
    technologyCosts,
    planPrices,
    targetsConfig,
    inflationIndex,
    backfillSnapshotsCalls,
    readUserId: readUser.id,
    costsUserId: costsUser.id,
    syncUserId: syncUser.id,
    noPermUserId: noPermUser.id,
    targetsUserId: targetsUser.id,
    inflationUserId: inflationUser.id,
  };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('GET /api/finance/growth/config/invoice-types', () => {
  it('sin finance:read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/finance/growth/config/invoice-types'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('con finance:read → 200 con la lista completa incl. unclassified', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/finance/growth/config/invoice-types'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body.types.map((t: { grType: string }) => t.grType).sort()).toEqual(['FB', 'XZ']);
  });
});

describe('PATCH /api/finance/growth/config/invoice-types/:grType', () => {
  it('sin finance:manage_costs → 403, sin cambio', async () => {
    const { app, noPermUserId, invoiceTypes } = await buildApp();
    const res = await asUser(request(app).patch('/api/finance/growth/config/invoice-types/XZ'), noPermUserId).send({ bucket: 'revenue' });
    expect(res.status).toBe(403);
    expect((await invoiceTypes.get('XZ'))?.bucket).toBe('unclassified');
  });

  it('con finance:manage_costs y bucket válido → 200, persiste', async () => {
    const { app, costsUserId, invoiceTypes } = await buildApp();
    const res = await asUser(request(app).patch('/api/finance/growth/config/invoice-types/XZ'), costsUserId).send({ bucket: 'revenue', label: 'Reclasificado' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ grType: 'XZ', bucket: 'revenue', label: 'Reclasificado' });
    expect((await invoiceTypes.get('XZ'))?.bucket).toBe('revenue');
  });

  it('con bucket: "unclassified" explícito → 400', async () => {
    const { app, costsUserId, invoiceTypes } = await buildApp();
    const res = await asUser(request(app).patch('/api/finance/growth/config/invoice-types/FB'), costsUserId).send({ bucket: 'unclassified' });
    expect(res.status).toBe(400);
    expect((await invoiceTypes.get('FB'))?.bucket).toBe('revenue'); // untouched
  });
});

describe('POST /api/finance/growth/sync/run', () => {
  it('sin finance:sync → 403, nada disparado', async () => {
    const { app, noPermUserId, state } = await buildApp();
    await state.save({ entity: 'finance-receipts-delta', cursor: '15-07-2026', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 1 });
    const res = await asUser(request(app).post('/api/finance/growth/sync/run'), noPermUserId);
    expect(res.status).toBe(403);
    expect((await state.get('finance-receipts-delta'))?.lastRunAt).not.toBeNull();
  });

  it('con finance:sync → 202 {started:true}', async () => {
    const { app, syncUserId } = await buildApp();
    const res = await asUser(request(app).post('/api/finance/growth/sync/run'), syncUserId);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ started: true });
  });

  // ── fix-wave-2 R3 — F6 removed the boot-time `enabled` gate, so the
  // scheduler OBJECT always exists whenever GR is on: `enabled=false` alone
  // used to still return 202 for a run NO tick would ever pick up (F6 broke
  // F8's 503 guard). The composition now goes through a REAL scheduler +
  // REAL config repo, exercising `isEnabled()` exactly as `app.ts` wires it —
  // not a hand-rolled boolean that proves nothing about the real logic.
  it('R3: FinanceReceiptSyncConfig.enabled=false (as observed by a tick) → 503 instead of a misleading 202', async () => {
    const { app, syncUserId, financeScheduler, financeSyncConfig } = await buildApp();
    await financeSyncConfig.update({ enabled: false });
    await financeScheduler.tick(); // the scheduler only learns `enabled` LIVE, via a tick (F6)

    const res = await asUser(request(app).post('/api/finance/growth/sync/run'), syncUserId);

    expect(res.status).toBe(503);
  });

  it('R3: a stop()ped scheduler → 503, even if the DB still says enabled=true', async () => {
    const { app, syncUserId, financeScheduler } = await buildApp();
    financeScheduler.stop();

    const res = await asUser(request(app).post('/api/finance/growth/sync/run'), syncUserId);

    expect(res.status).toBe(503);
  });

  it('R3: a scheduler that never ticked yet (fresh boot) is optimistically running → 202', async () => {
    const { app, syncUserId, financeScheduler } = await buildApp();
    expect(financeScheduler.isEnabled()).toBe(true); // optimistic default before the first tick

    const res = await asUser(request(app).post('/api/finance/growth/sync/run'), syncUserId);

    expect(res.status).toBe(202);
  });
});

// ── F9 — the backfill lane had NO re-arm path via the API at all.
describe('POST /api/finance/growth/sync/rearm-backfill', () => {
  it('sin finance:sync → 403, nada disparado', async () => {
    const { app, noPermUserId, state } = await buildApp();
    await state.save({ entity: 'finance-receipts-backfill', cursor: null, lastRunAt: new Date(), lastResult: 'done', itemsSynced: 500000 });

    const res = await asUser(request(app).post('/api/finance/growth/sync/rearm-backfill'), noPermUserId);

    expect(res.status).toBe(403);
    expect((await state.get('finance-receipts-backfill'))?.cursor).toBeNull(); // untouched
  });

  it('con finance:sync → 202, resetea el cursor al mes actual', async () => {
    const { app, syncUserId, state } = await buildApp();
    await state.save({ entity: 'finance-receipts-backfill', cursor: null, lastRunAt: new Date(), lastResult: 'done', itemsSynced: 500000 });

    const res = await asUser(request(app).post('/api/finance/growth/sync/rearm-backfill'), syncUserId);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ rearmed: true, cursor: '2026-07:0' });
    const saved = await state.get('finance-receipts-backfill');
    expect(saved?.cursor).toBe('2026-07:0');
    expect(saved?.itemsSynced).toBe(500000); // preserved, not wiped
  });

  // ── fix-wave-3 R10 — this lock IS load-bearing (RearmFinanceReceiptsBackfill
  // and a concurrent tick write the SAME `cursor` column), so a busy lock
  // must translate to a retriable 503 with `Retry-After` — NEVER a bare 500.
  // Before this fix, nothing anywhere tested the throw→HTTP-status
  // translation for this path at all.
  it('R10: cuando el lock está agotado → 503 con Retry-After, nunca 500', async () => {
    const busyLock = new InMemoryDistributedLock();
    busyLock.forceAcquireFails = true;
    const { app, syncUserId } = await buildApp({
      rearmBackfill: new RearmFinanceReceiptsBackfill(
        new InMemorySyncStateRepository(),
        busyLock,
        () => new Date('2026-07-15T12:00:00Z'),
        { maxLockAttempts: 2, retryDelayMs: 0, retryAfterSeconds: 3 },
      ),
    });

    const res = await asUser(request(app).post('/api/finance/growth/sync/rearm-backfill'), syncUserId);

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.body.code).toBe('FINANCE_SYNC_LOCK_BUSY');
  });
});

// finance-growth Fase 3 rework (J1) — the manual trigger for months the
// nightly job's 2-month rolling window never reaches.
describe('POST /api/finance/growth/sync/backfill-snapshots', () => {
  it('sin finance:sync → 403, nada disparado', async () => {
    const { app, noPermUserId, backfillSnapshotsCalls } = await buildApp();
    const res = await asUser(request(app).post('/api/finance/growth/sync/backfill-snapshots'), noPermUserId).send({ from: '2026-01', to: '2026-03' });
    expect(res.status).toBe(403);
    expect(backfillSnapshotsCalls).toEqual([]);
  });

  it('con finance:sync y rango válido → 200, delega al use case', async () => {
    const { app, syncUserId, backfillSnapshotsCalls } = await buildApp();
    const res = await asUser(request(app).post('/api/finance/growth/sync/backfill-snapshots'), syncUserId).send({ from: '2026-01', to: '2026-03' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ monthsComputed: ['2026-01'], monthsFailed: [] });
    expect(backfillSnapshotsCalls).toEqual([['2026-01', '2026-03']]);
  });

  it('con formato inválido → 400, nada disparado', async () => {
    const { app, syncUserId, backfillSnapshotsCalls } = await buildApp();
    const res = await asUser(request(app).post('/api/finance/growth/sync/backfill-snapshots'), syncUserId).send({ from: '2026-1', to: '2026-03' });
    expect(res.status).toBe(400);
    expect(backfillSnapshotsCalls).toEqual([]);
  });
});

describe('GET /api/finance/growth/sync/status', () => {
  it('sin finance:read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/finance/growth/sync/status'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('con finance:read → 200 con el shape exacto de design.md', async () => {
    const { app, readUserId, state } = await buildApp();
    await state.save({ entity: 'finance-receipts-delta', cursor: '15-07-2026', lastRunAt: new Date('2026-07-15T12:00:00Z'), lastResult: 'ok', itemsSynced: 2 });
    await state.save({ entity: 'finance-receipts-backfill', cursor: '2026-03:1300', lastRunAt: new Date('2026-07-15T11:00:00Z'), lastResult: 'page ok', itemsSynced: 5000 });
    await state.save({ entity: 'gr-debtor-balances', cursor: null, lastRunAt: new Date('2026-07-15T03:00:00Z'), lastResult: 'ok', itemsSynced: 75 });

    const res = await asUser(request(app).get('/api/finance/growth/sync/status'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      pacing: { requestIntervalMs: 20000, effectiveIntervalMs: 20000, degraded: false, consecutiveFailures: 0, activeLane: 'idle' },
      delta: { lastResult: 'ok', itemsSynced: 2, pendingPages: false, coveredThroughDate: '15-07-2026' },
      backfill: { lastResult: 'page ok', itemsSynced: 5000, cursorYearMonth: '2026-03', cursorPageOffset: 1300, done: false },
      debtorBalances: { lastResult: 'ok', itemsSynced: 75 },
    });
  });
});

// ── Fase 2 — settables CRUD ──────────────────────────────────────────────

describe('GET/PUT /api/finance/growth/config/technology-costs (task 2.12/2.13)', () => {
  it('2.12: GET sin finance:read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/finance/growth/config/technology-costs'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('con finance:read → 200, tecnología sin costo configurado aparece en 0', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/finance/growth/config/technology-costs'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body.technologies).toEqual([
      { technologyName: 'Fibra', costoVentaArs: 0, costoInstalacionArs: 0, costoMensualServicioArs: 0, comisionVentaPct: 0, updatedAt: null },
    ]);
  });

  it('2.13: PUT sin finance:manage_costs → 403, sin cambio', async () => {
    const { app, noPermUserId, technologyCosts } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/technology-costs/Fibra'), noPermUserId).send({
      costoVentaArs: 15000, costoInstalacionArs: 20000, costoMensualServicioArs: 3000, comisionVentaPct: 5,
    });
    expect(res.status).toBe(403);
    expect(await technologyCosts.getByTechnology('Fibra')).toBeNull();
  });

  it('2.13: PUT con permiso y payload inválido → 400, sin cambio', async () => {
    const { app, costsUserId, technologyCosts } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/technology-costs/Fibra'), costsUserId).send({
      costoVentaArs: 15000, costoInstalacionArs: -1, costoMensualServicioArs: 3000, comisionVentaPct: 5,
    });
    expect(res.status).toBe(400);
    expect(await technologyCosts.getByTechnology('Fibra')).toBeNull();
  });

  it('2.13: PUT con permiso y payload válido → 200, un GET posterior refleja el cambio', async () => {
    const { app, costsUserId, readUserId } = await buildApp();
    const putRes = await asUser(request(app).put('/api/finance/growth/config/technology-costs/Fibra'), costsUserId).send({
      costoVentaArs: 15000, costoInstalacionArs: 20000, costoMensualServicioArs: 3000, comisionVentaPct: 5,
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body).toMatchObject({ technologyName: 'Fibra', costoVentaArs: 15000, costoInstalacionArs: 20000, costoMensualServicioArs: 3000, comisionVentaPct: 5 });

    const getRes = await asUser(request(app).get('/api/finance/growth/config/technology-costs'), readUserId);
    expect(getRes.body.technologies).toContainEqual(expect.objectContaining({ technologyName: 'Fibra', costoVentaArs: 15000 }));
  });

  // ── fix-wave-1 C — mutation M3 (`req.user?.id` → a literal) survived
  // 35/35 green because nothing asserted `updatedByUserId`. The DTO doesn't
  // expose the field, but the harness already has the in-memory repo, so
  // asserting against it closes the seam without touching the DTO/wire
  // contract.
  it('C: persists updatedByUserId as the REAL actor (repo in-memory, DTO omits it — closes mutation M3)', async () => {
    const { app, costsUserId, technologyCosts } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/technology-costs/Fibra'), costsUserId).send({
      costoVentaArs: 15000, costoInstalacionArs: 20000, costoMensualServicioArs: 3000, comisionVentaPct: 5,
    });
    expect(res.status).toBe(200);
    expect((await technologyCosts.getByTechnology('Fibra'))?.updatedByUserId).toBe(costsUserId);
  });

  // ── fix-wave-1 D — a typo'd/renamed technologyName used to upsert a
  // silent orphan: 200 OK, but GetFinanceTechnologyCosts' catalog-driven
  // LEFT JOIN never surfaces it (only 'Fibra' is seeded in the catalog).
  it('D: PUT con technologyName fuera del catálogo (typo) → 404, no persiste ningún huérfano', async () => {
    const { app, costsUserId, technologyCosts } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/technology-costs/Fibrra'), costsUserId).send({
      costoVentaArs: 15000, costoInstalacionArs: 20000, costoMensualServicioArs: 3000, comisionVentaPct: 5,
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('FINANCE_TECHNOLOGY_NOT_FOUND');
    expect(await technologyCosts.getByTechnology('Fibrra')).toBeNull();
  });

  // ── re-review de fix-wave-1 (🔵-6) — el guard de D resuelve el catálogo con
  // `getByName`, que es case-insensitive en LOS DOS adapters, y persiste bajo el
  // nombre CANÓNICO. Eso evita de paso una segunda fila variante de casing para
  // la misma tecnología. Pero nada lo pineaba: si alguien "optimiza" `getByName`
  // a `findUnique({where:{name}})` (lo natural, porque `name` es @unique), este
  // PUT pasaría a dar 404 y la suite quedaría verde igual.
  it('🔵-6: PUT con distinto casing resuelve el catálogo y persiste bajo el nombre CANÓNICO', async () => {
    const { app, costsUserId, technologyCosts } = await buildApp();

    const res = await asUser(request(app).put('/api/finance/growth/config/technology-costs/fibra'), costsUserId).send({
      costoVentaArs: 15000, costoInstalacionArs: 20000, costoMensualServicioArs: 3000, comisionVentaPct: 5,
    });

    expect(res.status).toBe(200);
    expect(res.body.technologyName).toBe('Fibra'); // canónico del catálogo, no el 'fibra' del path
    // La fila vive bajo el nombre canónico...
    expect(await technologyCosts.getByTechnology('Fibra')).not.toBeNull();
    // ...y NO se creó una segunda fila variante de casing.
    const all = await technologyCosts.list();
    expect(all.filter((r) => r.technologyName.toLowerCase() === 'fibra')).toHaveLength(1);
  });
});

describe('GET/PUT /api/finance/growth/config/plan-prices (task 2.19)', () => {
  it('GET sin finance:read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/finance/growth/config/plan-prices'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('con finance:read → 200, plan sin precio configurado aparece en 0', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/finance/growth/config/plan-prices'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body.plans).toEqual([{ planCode: 'IP-Fibra-100-50', planName: 'Fibra 100/50', estimatedMonthlyPrice: 0, updatedAt: null }]);
  });

  it('PUT sin finance:manage_costs → 403, sin cambio', async () => {
    const { app, noPermUserId, planPrices } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/plan-prices/IP-Fibra-100-50'), noPermUserId).send({ estimatedMonthlyPrice: 12000 });
    expect(res.status).toBe(403);
    expect(await planPrices.getByPlanCode('IP-Fibra-100-50')).toBeNull();
  });

  it('PUT con permiso y payload inválido (negativo) → 400, sin cambio', async () => {
    const { app, costsUserId, planPrices } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/plan-prices/IP-Fibra-100-50'), costsUserId).send({ estimatedMonthlyPrice: -1 });
    expect(res.status).toBe(400);
    expect(await planPrices.getByPlanCode('IP-Fibra-100-50')).toBeNull();
  });

  it('PUT con permiso y payload válido → 200, un GET posterior refleja el cambio', async () => {
    const { app, costsUserId, readUserId } = await buildApp();
    const putRes = await asUser(request(app).put('/api/finance/growth/config/plan-prices/IP-Fibra-100-50'), costsUserId).send({ estimatedMonthlyPrice: 12000 });
    expect(putRes.status).toBe(200);

    const getRes = await asUser(request(app).get('/api/finance/growth/config/plan-prices'), readUserId);
    expect(getRes.body.plans).toContainEqual(expect.objectContaining({ planCode: 'IP-Fibra-100-50', estimatedMonthlyPrice: 12000 }));
  });

  // ── fix-wave-1 LOW F — the PUT response used to omit `planName` while the
  // GET row always carries it (the other 3 settables' PUT already assert
  // their full body with toEqual/toMatchObject; this one only checked
  // `status === 200`).
  it('F: el body del PUT incluye planName (no solo status 200)', async () => {
    const { app, costsUserId } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/plan-prices/IP-Fibra-100-50'), costsUserId).send({ estimatedMonthlyPrice: 12000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ planCode: 'IP-Fibra-100-50', planName: 'Fibra 100/50', estimatedMonthlyPrice: 12000 });
  });

  // ── fix-wave-1 C — same seam as technology-costs: mutation M3 survived
  // because nothing asserted `updatedByUserId` on this endpoint's actor.
  it('C: persists updatedByUserId as the REAL actor (repo in-memory — closes mutation M3)', async () => {
    const { app, costsUserId, planPrices } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/plan-prices/IP-Fibra-100-50'), costsUserId).send({ estimatedMonthlyPrice: 12000 });
    expect(res.status).toBe(200);
    expect((await planPrices.getByPlanCode('IP-Fibra-100-50'))?.updatedByUserId).toBe(costsUserId);
  });

  // ── fix-wave-1 D — a typo'd/retired planCode used to upsert a silent
  // orphan (only 'IP-Fibra-100-50' is seeded in the catalog).
  it('D: PUT con planCode fuera del catálogo (typo) → 404, no persiste ningún huérfano', async () => {
    const { app, costsUserId, planPrices } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/plan-prices/IP-Nope-404'), costsUserId).send({ estimatedMonthlyPrice: 12000 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('FINANCE_PLAN_NOT_FOUND');
    expect(await planPrices.getByPlanCode('IP-Nope-404')).toBeNull();
  });
});

describe('GET/PUT /api/finance/growth/config/targets (task 2.26)', () => {
  it('GET sin finance:read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/finance/growth/config/targets'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('con finance:read → 200 con los defaults seedeados', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/finance/growth/config/targets'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '' });
  });

  it('PUT sin finance:manage_targets → 403, sin cambio (finance:manage_costs NO alcanza)', async () => {
    const { app, costsUserId, targetsConfig } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/targets'), costsUserId).send({
      churnTargetPct: 4, maxPaybackMonths: 10, monthlyNewContractsGoal: 100, inflationBaseYearMonth: '2026-01',
    });
    expect(res.status).toBe(403);
    expect(await targetsConfig.get()).toMatchObject({ churnTargetPct: 5 });
  });

  it('PUT con finance:manage_targets y payload válido → 200, persiste los 4 campos', async () => {
    const { app, targetsUserId, readUserId } = await buildApp();
    const payload = { churnTargetPct: 4, maxPaybackMonths: 10, monthlyNewContractsGoal: 100, inflationBaseYearMonth: '2026-01' };
    const putRes = await asUser(request(app).put('/api/finance/growth/config/targets'), targetsUserId).send(payload);
    expect(putRes.status).toBe(200);
    expect(putRes.body).toEqual(payload);

    const getRes = await asUser(request(app).get('/api/finance/growth/config/targets'), readUserId);
    expect(getRes.body).toEqual(payload);
  });

  it('PUT con payload inválido (churnTargetPct fuera de rango) → 400, sin cambio', async () => {
    const { app, targetsUserId, targetsConfig } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/targets'), targetsUserId).send({
      churnTargetPct: 200, maxPaybackMonths: 10, monthlyNewContractsGoal: 100, inflationBaseYearMonth: '2026-01',
    });
    expect(res.status).toBe(400);
    expect(await targetsConfig.get()).toMatchObject({ churnTargetPct: 5 });
  });

  // ── fix-wave-1 LOW G — `/config/targets` replaces the WHOLE singleton row
  // (no per-field PATCH semantics); nothing exercised a PARTIAL body. The
  // current behavior IS correct (zod requires the 4 fields, the use case
  // type-guards each one), but nothing here protects it: a future `.partial()`
  // "so the FE only sends what changed" would silently wipe real targets
  // with the suite still green. This pins the 400 + untouched-singleton
  // invariant explicitly.
  it('G: PUT con payload PARCIAL (falta monthlyNewContractsGoal) → 400, sin cambio', async () => {
    const { app, targetsUserId, targetsConfig } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/targets'), targetsUserId).send({
      churnTargetPct: 4, maxPaybackMonths: 10, inflationBaseYearMonth: '2026-01',
    });
    expect(res.status).toBe(400);
    expect(await targetsConfig.get()).toEqual({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '' });
  });
});

describe('GET/PUT /api/finance/growth/config/inflation (task 2.32)', () => {
  it('GET sin finance:read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/finance/growth/config/inflation'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('con finance:read → 200 con la serie', async () => {
    const { app, readUserId, inflationIndex } = await buildApp();
    await inflationIndex.upsert('2026-01', { monthlyRatePct: 4.2, source: 'INDEC' });
    const res = await asUser(request(app).get('/api/finance/growth/config/inflation'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body.index).toEqual([{ yearMonth: '2026-01', monthlyRatePct: 4.2, source: 'INDEC' }]);
  });

  it('PUT sin finance:manage_inflation → 403, sin cambio (finance:manage_costs NO alcanza — acción separada)', async () => {
    const { app, costsUserId, inflationIndex } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/inflation/2026-01'), costsUserId).send({ monthlyRatePct: 4.2, source: 'INDEC' });
    expect(res.status).toBe(403);
    expect(await inflationIndex.list()).toEqual([]);
  });

  it('PUT con finance:manage_inflation y payload válido → 200, un GET posterior refleja el cambio', async () => {
    const { app, inflationUserId, readUserId } = await buildApp();
    const putRes = await asUser(request(app).put('/api/finance/growth/config/inflation/2026-01'), inflationUserId).send({ monthlyRatePct: 4.2, source: 'INDEC' });
    expect(putRes.status).toBe(200);
    expect(putRes.body).toEqual({ yearMonth: '2026-01', monthlyRatePct: 4.2, source: 'INDEC' });

    const getRes = await asUser(request(app).get('/api/finance/growth/config/inflation'), readUserId);
    expect(getRes.body.index).toEqual([{ yearMonth: '2026-01', monthlyRatePct: 4.2, source: 'INDEC' }]);
  });

  it('PUT con yearMonth de path inválido → 400, sin cambio', async () => {
    const { app, inflationUserId, inflationIndex } = await buildApp();
    const res = await asUser(request(app).put('/api/finance/growth/config/inflation/not-a-month'), inflationUserId).send({ monthlyRatePct: 4.2 });
    expect(res.status).toBe(400);
    expect(await inflationIndex.list()).toEqual([]);
  });

  // ── fix-wave-1 B — `from`/`to` reached `gte`/`lte` raw, un-validated.
  it('B: GET con from/to mal formados (sin padStart, "2026-1") → 400', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/finance/growth/config/inflation?from=2026-1&to=2026-6'), readUserId);
    expect(res.status).toBe(400);
  });

  // ── re-review de fix-wave-1 (🔵-3) — el guard de B trataba el string VACÍO
  // como un valor inválido. `URLSearchParams` emite `?from=&to=` cuando el FE
  // tiene el filtro sin setear, así que ese 400 era una trampa para la pantalla
  // de config que todavía no existe. Vacío = "sin filtro" = serie completa.
  it('🔵-3: GET con ?from=&to= vacíos NO es 400 — devuelve la serie completa', async () => {
    const { app, readUserId, inflationIndex } = await buildApp();
    await inflationIndex.upsert('2026-01', { monthlyRatePct: 4.2, source: 'INDEC' });
    await inflationIndex.upsert('2026-02', { monthlyRatePct: 3.1, source: 'INDEC' });

    const res = await asUser(request(app).get('/api/finance/growth/config/inflation?from=&to='), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.index.map((r: { yearMonth: string }) => r.yearMonth)).toEqual(['2026-01', '2026-02']);
  });

  // ── fix-wave-1 B — mutation M2 (`req.query['from'/'to']` → `'desde'/'hasta'`)
  // survived 35/35 green because the ONLY existing test for this GET never
  // sent a query string at all. This test sends a REAL `?from=&to=` and
  // asserts the filter actually reached the use case — a param-name swap
  // would now return the FULL series instead of the filtered slice, failing
  // this assertion.
  it('B: GET con from/to reales filtra la serie (cierra mutación M2)', async () => {
    const { app, readUserId, inflationIndex } = await buildApp();
    await inflationIndex.upsert('2026-01', { monthlyRatePct: 4.2, source: 'INDEC' });
    await inflationIndex.upsert('2026-03', { monthlyRatePct: 3.1, source: 'INDEC' });
    await inflationIndex.upsert('2026-06', { monthlyRatePct: 2.5, source: 'INDEC' });

    const res = await asUser(request(app).get('/api/finance/growth/config/inflation?from=2026-02&to=2026-05'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.index).toEqual([{ yearMonth: '2026-03', monthlyRatePct: 3.1, source: 'INDEC' }]);
  });
});
