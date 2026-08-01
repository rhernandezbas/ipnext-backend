import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { SyncIClassStatuses } from '@application/use-cases/SyncIClassStatuses';
import { ListIClassStatusCatalog } from '@application/use-cases/ListIClassStatusCatalog';
import { UpdateIClassStatusCatalog } from '@application/use-cases/UpdateIClassStatusCatalog';
import { toStatusCatalogDTO, UpdateStatusSchema } from '@application/dto/iclassStatus.dto';

/**
 * Admin routes for the IClass status catalog.
 *
 *   GET   /statuses             — list all catalog entries (gate: iclass.read)
 *   POST  /statuses/sync        — discover status codes from recent SOs (gate: iclass.manage)
 *   PATCH /statuses/:statusCode — edit displayLabel / color / tracked (gate: iclass.manage)
 *
 * Mount at /api/admin/iclass (same base as the closure router).
 * Sub-resource routes MUST be registered BEFORE any catch-all /:id to avoid route shadowing.
 *
 * @param requireIClassRead  — auth middleware for iclass.read (e.g. requirePerm('iclass','read'))
 * @param requireIClassManage — auth middleware for iclass.manage
 */
export function createIClassStatusesRouter(
  syncIClassStatuses: SyncIClassStatuses,
  listIClassStatusCatalog: ListIClassStatusCatalog,
  updateIClassStatusCatalog: UpdateIClassStatusCatalog,
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requireIClassRead: RequestHandler,
  requireIClassManage: RequestHandler,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider, sessionRepo);

  // GET /statuses — list the status catalog (iclass.read)
  router.get('/statuses', auth, requireIClassRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const entries = await listIClassStatusCatalog.execute();
      res.status(200).json({ items: entries.map(toStatusCatalogDTO) });
    } catch (err) {
      next(err);
    }
  });

  // POST /statuses/sync — manual discovery of status codes (iclass.manage)
  // MUST be registered BEFORE /statuses/:statusCode to avoid 'sync' being treated as a :statusCode
  router.post('/statuses/sync', auth, requireIClassManage, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await syncIClassStatuses.execute();
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /statuses/:statusCode — edit config (iclass.manage)
  router.patch('/statuses/:statusCode', auth, requireIClassManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const updated = await updateIClassStatusCatalog.execute(req.params.statusCode, parsed.data);
      res.status(200).json(toStatusCatalogDTO(updated));
    } catch (err) {
      next(err); // IClassStatusNotFoundError → 404
    }
  });

  return router;
}
