import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { ListFinanceInvoiceTypes } from '@application/use-cases/finance/ListFinanceInvoiceTypes';
import { ReclassifyFinanceInvoiceType } from '@application/use-cases/finance/ReclassifyFinanceInvoiceType';
import { GetFinanceSyncStatus } from '@application/use-cases/finance/GetFinanceSyncStatus';
import { ForceFinanceDeltaRun } from '@application/use-cases/finance/ForceFinanceDeltaRun';
import { RearmFinanceReceiptsBackfill } from '@application/use-cases/finance/RearmFinanceReceiptsBackfill';
import { GetFinanceTechnologyCosts } from '@application/use-cases/finance/GetFinanceTechnologyCosts';
import { UpdateFinanceTechnologyCost } from '@application/use-cases/finance/UpdateFinanceTechnologyCost';
import { GetFinancePlanPrices } from '@application/use-cases/finance/GetFinancePlanPrices';
import { UpdateFinancePlanPrice } from '@application/use-cases/finance/UpdateFinancePlanPrice';
import { GetFinanceTargets } from '@application/use-cases/finance/GetFinanceTargets';
import { UpdateFinanceTargets } from '@application/use-cases/finance/UpdateFinanceTargets';
import { ListFinanceInflationIndex } from '@application/use-cases/finance/ListFinanceInflationIndex';
import { UpdateFinanceInflationIndex } from '@application/use-cases/finance/UpdateFinanceInflationIndex';
import { BackfillFinanceMonthlySnapshots } from '@application/use-cases/finance/BackfillFinanceMonthlySnapshots';
import { isValidYearMonth } from '@application/use-cases/finance/financeDates';
import {
  toFinanceInvoiceTypeDto,
  toFinanceSyncStatusDto,
  ReclassifyFinanceInvoiceTypeSchema,
  FinancePacingStatusDto,
  toFinanceTechnologyCostDto,
  UpdateFinanceTechnologyCostSchema,
  toFinancePlanPriceDto,
  UpdateFinancePlanPriceSchema,
  toFinanceTargetsDto,
  UpdateFinanceTargetsSchema,
  toFinanceInflationIndexDto,
  UpdateFinanceInflationIndexSchema,
  BackfillFinanceMonthlySnapshotsSchema,
} from '@application/dto/financeGrowth.dto';

/** Factory matching `requirePerm` exported from app.ts (molde `alerts.routes.ts`). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

export interface FinanceGrowthRouterDeps {
  auth: RequestHandler;
  requirePerm: RequirePerm;
  listInvoiceTypes: ListFinanceInvoiceTypes;
  reclassifyInvoiceType: ReclassifyFinanceInvoiceType;
  getSyncStatus: GetFinanceSyncStatus;
  forceDeltaRun: ForceFinanceDeltaRun;
  /** fix-wave-1 F9 — resets the backfill cursor to the current month; the ONLY way to revive a disarmed backfill via the API. */
  rearmBackfill: RearmFinanceReceiptsBackfill;
  /**
   * fix-wave-2 R3 (supersedes fix-wave-1 F8's original `!= null` check) —
   * true iff a tick will ACTUALLY pick up a forced run: the scheduler exists,
   * its live `FinanceReceiptSyncConfig.enabled` (as last observed by a tick)
   * is true, and `stop()` was never called. Since F6, the scheduler OBJECT
   * exists whenever GR itself is on regardless of the DB `enabled` flag (it
   * re-reads that flag every tick instead of gating at boot) — so mere
   * existence stopped being a reliable signal. `POST /sync/run` refuses with
   * `503` instead of lying with `202 {started:true}` when this is false —
   * forcing a run that will NEVER be picked up by any tick is worse than an
   * honest error.
   */
  isSchedulerRunning: () => boolean;
  /**
   * Reads the LIVE in-memory pacing snapshot from `FinanceReceiptIngestScheduler`
   * fresh per-request — the backoff state is process-memory only (design.md
   * Decision 4b), never persisted, so this is a getter, not a stored value.
   */
  getPacingStatus: () => FinancePacingStatusDto;

  // finance-growth Fase 2 — settables CRUD (design.md HTTP Contract).
  getTechnologyCosts: GetFinanceTechnologyCosts;
  updateTechnologyCost: UpdateFinanceTechnologyCost;
  getPlanPrices: GetFinancePlanPrices;
  updatePlanPrice: UpdateFinancePlanPrice;
  getTargets: GetFinanceTargets;
  updateTargets: UpdateFinanceTargets;
  listInflationIndex: ListFinanceInflationIndex;
  updateInflationIndex: UpdateFinanceInflationIndex;

  /**
   * finance-growth Fase 3 rework (J1) — manual trigger for the backfill of
   * `FinanceMonthlySnapshot`/`FinanceCohortSnapshot` over an explicit
   * `[from, to]` range. Without this, the nightly job's 2-month rolling
   * window (`FinanceSnapshotScheduler`) would NEVER produce rows for older
   * months, no matter how much receipt history Fase 1 backfills.
   */
  backfillSnapshots: BackfillFinanceMonthlySnapshots;
}

/**
 * finance-growth Fase 1 — `/api/finance/growth/*`. Every route requires
 * session (`auth`) + its `finance:*` guard (spec.md "Two-layer permission
 * model" — the BE guard is NEVER "solo autenticado").
 */
export function createFinanceGrowthRouter(deps: FinanceGrowthRouterDeps): Router {
  const router = Router();
  const readPerm = deps.requirePerm('finance', 'read');
  const manageCostsPerm = deps.requirePerm('finance', 'manage_costs');
  const manageTargetsPerm = deps.requirePerm('finance', 'manage_targets');
  const manageInflationPerm = deps.requirePerm('finance', 'manage_inflation');
  const syncPerm = deps.requirePerm('finance', 'sync');

  // ── Fase 2 — GET /config/technology-costs · PUT /config/technology-costs/:technologyName ──
  // finance:read / finance:manage_costs (design.md HTTP Contract).

  router.get('/config/technology-costs', deps.auth, readPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rows = await deps.getTechnologyCosts.execute();
      res.json({ technologies: rows.map(toFinanceTechnologyCostDto) });
    } catch (err) {
      next(err);
    }
  });

  router.put(
    '/config/technology-costs/:technologyName',
    deps.auth,
    manageCostsPerm,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = UpdateFinanceTechnologyCostSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const updated = await deps.updateTechnologyCost.execute(
          req.params['technologyName'] as string,
          parsed.data,
          req.user?.id as string,
        );
        res.json(toFinanceTechnologyCostDto(updated));
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Fase 2 — GET /config/plan-prices · PUT /config/plan-prices/:planCode ──
  // finance:read / finance:manage_costs.

  router.get('/config/plan-prices', deps.auth, readPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rows = await deps.getPlanPrices.execute();
      res.json({ plans: rows.map(toFinancePlanPriceDto) });
    } catch (err) {
      next(err);
    }
  });

  router.put(
    '/config/plan-prices/:planCode',
    deps.auth,
    manageCostsPerm,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = UpdateFinancePlanPriceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const updated = await deps.updatePlanPrice.execute(req.params['planCode'] as string, parsed.data, req.user?.id as string);
        // fix-wave-1 LOW F — `planName` now travels in the response (the use
        // case already resolved it from the catalog for the D existence
        // guard). Before this fix, the PUT response omitted it while the GET
        // row always carries it — a FE patching its local row with the PUT
        // response left `planName` `undefined` until the next GET, the exact
        // asymmetry that produced the blank-row incident this comment used
        // to warn about.
        res.json({
          planCode: updated.planCode,
          planName: updated.planName,
          estimatedMonthlyPrice: updated.estimatedMonthlyPrice,
          updatedAt: updated.updatedAt.toISOString(),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Fase 2 — GET /config/targets · PUT /config/targets ──
  // finance:read / finance:manage_targets.

  router.get('/config/targets', deps.auth, readPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const targets = await deps.getTargets.execute();
      res.json(toFinanceTargetsDto(targets));
    } catch (err) {
      next(err);
    }
  });

  router.put('/config/targets', deps.auth, manageTargetsPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateFinanceTargetsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const updated = await deps.updateTargets.execute(parsed.data);
      res.json(toFinanceTargetsDto(updated));
    } catch (err) {
      next(err);
    }
  });

  // ── Fase 2 — GET /config/inflation?from&to · PUT /config/inflation/:yearMonth ──
  // finance:read / finance:manage_inflation (acción SEPARADA de manage_costs).

  // fix-wave-1 B — `from`/`to` were forwarded RAW to a lexicographic string
  // compare (`gte`/`lte` on `yearMonth`, in-memory's `compareYearMonth`,
  // Prisma's adapter alike). An un-padded month (`?from=2026-1`, a FE bug —
  // month built without `padStart`) sorts AFTER `2026-09` lexicographically
  // (`'2026-1' > '2026-09'`), silently returning the wrong slice of the
  // series with a `200` and zero signal. `isValidYearMonth` already exists
  // and is already used by the PUT below — it just wasn't wired here.
  // re-review of fix-wave-1 (🔵-3) — an EMPTY string is "no filter", not an
  // invalid one. `URLSearchParams` emits `?from=&to=` when the FE has the filter
  // unset (the standard behaviour of building a query object with undefined
  // values), and the first version of this guard turned that into a `400` where
  // it used to return the whole series. Normalising `''` → `undefined` here
  // keeps the guard honest without trapping the FE that hasn't been written yet.
  router.get('/config/inflation', deps.auth, readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawFrom = req.query['from'];
    const rawTo = req.query['to'];
    const from = typeof rawFrom === 'string' && rawFrom !== '' ? rawFrom : undefined;
    const to = typeof rawTo === 'string' && rawTo !== '' ? rawTo : undefined;
    if (from !== undefined && !isValidYearMonth(from)) {
      res.status(400).json({ error: 'from must be a valid "YYYY-MM"', code: 'VALIDATION_ERROR' });
      return;
    }
    if (to !== undefined && !isValidYearMonth(to)) {
      res.status(400).json({ error: 'to must be a valid "YYYY-MM"', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const rows = await deps.listInflationIndex.execute(from, to);
      res.json({ index: rows.map(toFinanceInflationIndexDto) });
    } catch (err) {
      next(err);
    }
  });

  router.put(
    '/config/inflation/:yearMonth',
    deps.auth,
    manageInflationPerm,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = UpdateFinanceInflationIndexSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const updated = await deps.updateInflationIndex.execute(req.params['yearMonth'] as string, parsed.data);
        res.json(toFinanceInflationIndexDto(updated));
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /config/invoice-types — finance:read.
  router.get('/config/invoice-types', deps.auth, readPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const types = await deps.listInvoiceTypes.execute();
      res.json({ types: types.map(toFinanceInvoiceTypeDto) });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /config/invoice-types/:grType — finance:manage_costs. `bucket:
  // 'unclassified'` is rejected by the zod schema (spec.md "unclassified NO
  // es un valor válido de entrada").
  router.patch(
    '/config/invoice-types/:grType',
    deps.auth,
    manageCostsPerm,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = ReclassifyFinanceInvoiceTypeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const updated = await deps.reclassifyInvoiceType.execute(
          req.params['grType'] as string,
          parsed.data.bucket,
          parsed.data.label ?? null,
        );
        res.json(toFinanceInvoiceTypeDto(updated));
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /sync/run — finance:sync. Forces the delta lane due on the NEXT
  // tick; never touches the backfill cursor (design.md "POST /sync/run").
  // fix-wave-2 R3 (supersedes fix-wave-1 F8's original comment): refuses with
  // 503 when `isSchedulerRunning()` is false — the scheduler is either
  // entirely absent (GR off/misconfigured) OR its LIVE `enabled` kill-switch
  // is off OR it was `stop()`ped; in every case no tick will EVER pick this
  // up, so a 202 would be a lie.
  // fix-wave-4 micro — LATENCY NOTE for whoever presses this button: R10
  // widened `ForceFinanceDeltaRun`'s lock-retry budget from ~80ms to up to
  // ~4s (`PgAdvisoryLock`'s shared session, 40 x 100ms `tryAcquire` attempts)
  // to match the tick's REAL lock hold (4 `$transaction`s + N upserts, not
  // just the GR fetch). A human clicking "force sync" can see this endpoint
  // take up to ~4s to answer under normal load — that is expected, not a hang.
  router.post('/sync/run', deps.auth, syncPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!deps.isSchedulerRunning()) {
      res.status(503).json({ error: 'finance receipt ingest scheduler is not running', code: 'SCHEDULER_NOT_RUNNING' });
      return;
    }
    try {
      const result = await deps.forceDeltaRun.execute();
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /sync/rearm-backfill — finance:sync (fix-wave-1 F9). Resets the
  // backfill cursor to the current calendar month, offset 0 — an explicit
  // restart of the newest→oldest walk. Same guard as /sync/run: this is an
  // operational sync action, not a business settable, so it reuses `sync`
  // rather than minting a 6th finance action.
  // fix-wave-4 micro — same LATENCY NOTE as /sync/run above: R6/R10 size this
  // endpoint's lock-retry budget the same way (up to ~4s, `PgAdvisoryLock`'s
  // shared session), so it can also take up to ~4s to answer under normal load.
  router.post('/sync/rearm-backfill', deps.auth, syncPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await deps.rearmBackfill.execute();
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /sync/backfill-snapshots — finance:sync (finance-growth Fase 3
  // rework, J1). Synchronous (this is a bounded, admin-triggered one-shot,
  // NOT a resumable background scheduler — see BackfillFinanceMonthlySnapshots'
  // docblock) — computes BuildFinanceMonthlySnapshot + BuildFinanceCohortSnapshot
  // for every month in `[from, to]` inclusive, one month failing doesn't
  // abort the rest. This is the ONLY way `FinanceMonthlySnapshot` ever gets
  // rows for months older than the nightly job's 2-month rolling window.
  router.post(
    '/sync/backfill-snapshots',
    deps.auth,
    syncPerm,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = BackfillFinanceMonthlySnapshotsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const result = await deps.backfillSnapshots.execute(parsed.data.from, parsed.data.to);
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /sync/status — finance:read.
  router.get('/sync/status', deps.auth, readPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const status = await deps.getSyncStatus.execute();
      res.json(toFinanceSyncStatusDto(status, deps.getPacingStatus()));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
