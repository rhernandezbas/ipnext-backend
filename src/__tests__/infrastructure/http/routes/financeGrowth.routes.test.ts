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

  const readPerm = await permRepo.seed({ moduleCode: 'finance', action: 'read' });
  const costsPerm = await permRepo.seed({ moduleCode: 'finance', action: 'manage_costs' });
  const syncPerm = await permRepo.seed({ moduleCode: 'finance', action: 'sync' });
  await rolePermRepo.grant(readRole.id, readPerm.id);
  await rolePermRepo.grant(costsRole.id, costsPerm.id);
  await rolePermRepo.grant(syncRole.id, syncPerm.id);

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
    }),
  );
  app.use(errorHandler);

  return {
    app,
    invoiceTypes,
    state,
    financeScheduler,
    financeSyncConfig,
    readUserId: readUser.id,
    costsUserId: costsUser.id,
    syncUserId: syncUser.id,
    noPermUserId: noPermUser.id,
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
