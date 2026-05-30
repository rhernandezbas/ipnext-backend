/**
 * auditEvents.routes.ts — GET /api/admin/audit-events (SDD #4 Phase 3).
 *
 * Mounted at /api/admin/audit-events, protected by requirePerm('admin','view_activity_log').
 * Returns a paginated, filtered page of AuditEventDto (createdAt DESC).
 */
import { Router, Request, Response, NextFunction } from 'express';
import type { ListAuditEvents } from '@application/use-cases/audit/ListAuditEvents';
import { AuditEventQuerySchema } from '@application/dto/audit.dto';

export function createAuditEventsRouter(listAuditEvents: ListAuditEvents): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = AuditEventQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query parameters', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const page = await listAuditEvents.execute(parsed.data);
      res.json(page);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
