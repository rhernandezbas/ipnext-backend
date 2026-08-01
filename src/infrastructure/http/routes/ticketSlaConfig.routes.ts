import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { GetTicketSlaConfig } from '@application/use-cases/GetTicketSlaConfig';
import { UpdateTicketSlaConfig } from '@application/use-cases/UpdateTicketSlaConfig';
import { UpdateTicketSlaConfigSchema } from '@application/dto/tickets.dto';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/**
 * #79 — Ticket SLA timer config (singleton). Mount at /api/tickets/sla-config,
 * BEFORE the tickets router so the /:id catch-all doesn't swallow /sla-config.
 *
 *   GET /api/tickets/sla-config  — read thresholds (tickets.read)
 *   PUT /api/tickets/sla-config  — patch thresholds (tickets.manage)
 *
 * The cross-field invariant (dangerMinutes > warnMinutes) is enforced in the
 * use case → TicketSlaThresholdOrderError → 422 via the global error handler.
 */
export function createTicketSlaConfigRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  getConfig: GetTicketSlaConfig,
  updateConfig: UpdateTicketSlaConfig,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider, sessionRepo);
  const readPerm = requirePerm('tickets', 'read');
  const managePerm = requirePerm('tickets', 'manage');

  router.get('/', auth, readPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await getConfig.execute());
    } catch (err) {
      next(err);
    }
  });

  router.put('/', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateTicketSlaConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.status(200).json(await updateConfig.execute(parsed.data));
    } catch (err) {
      next(err); // TicketSlaThresholdOrderError → 422
    }
  });

  return router;
}
