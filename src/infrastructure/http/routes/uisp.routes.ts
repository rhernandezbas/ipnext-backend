import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { ListUispSites } from '@application/use-cases/ListUispSites';
import type { GetUispSiteDetail } from '@application/use-cases/GetUispSiteDetail';
import type { GetUispSyncStatus } from '@application/use-cases/GetUispSyncStatus';
import type { TriggerUispSync } from '@application/use-cases/TriggerUispSync';
import { UispSiteNotFoundError } from '@domain/errors/uisp';

/**
 * UISP mirror read + sync routes.
 *
 * GET  /sites          (uisp.read)   → { sites: UispSiteRow[] }
 * GET  /sites/:uispId  (uisp.read)   → { site: UispSiteDetail, devices: UispDeviceRow[] }
 * GET  /sync/status    (uisp.read)   → UispSyncStatusResult
 * POST /sync           (uisp.manage) → 202 { queued: true } | 409 { queued: false, reason }
 */
export function createUispRouter(
  listUispSites: ListUispSites,
  getUispSiteDetail: GetUispSiteDetail,
  getUispSyncStatus: GetUispSyncStatus,
  triggerUispSync: TriggerUispSync,
  requireRead: RequestHandler,
  requireManage: RequestHandler,
): Router {
  const router = Router();

  // GET /sites — list all mirrored sites
  router.get('/sites', requireRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await listUispSites.execute();
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /sync/status — sync status (must be before /:uispId to avoid route shadowing)
  router.get('/sync/status', requireRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await getUispSyncStatus.execute();
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /sites/:uispId — site detail + device list
  router.get('/sites/:uispId', requireRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await getUispSiteDetail.execute(req.params['uispId'] as string);
      res.json(result);
    } catch (err) {
      if (err instanceof UispSiteNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  // POST /sync — manual trigger (fire-and-forget)
  router.post('/sync', requireManage, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await triggerUispSync.execute();
      if (result.queued) {
        res.status(202).json({ queued: true });
      } else {
        res.status(409).json({ queued: false, reason: result.reason });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
