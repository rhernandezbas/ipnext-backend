import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { ListFinanceInvoiceTypes } from '@application/use-cases/finance/ListFinanceInvoiceTypes';
import { ReclassifyFinanceInvoiceType } from '@application/use-cases/finance/ReclassifyFinanceInvoiceType';
import { GetFinanceSyncStatus } from '@application/use-cases/finance/GetFinanceSyncStatus';
import { ForceFinanceDeltaRun } from '@application/use-cases/finance/ForceFinanceDeltaRun';
import { RearmFinanceReceiptsBackfill } from '@application/use-cases/finance/RearmFinanceReceiptsBackfill';
import {
  toFinanceInvoiceTypeDto,
  toFinanceSyncStatusDto,
  ReclassifyFinanceInvoiceTypeSchema,
  FinancePacingStatusDto,
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
  const syncPerm = deps.requirePerm('finance', 'sync');

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
