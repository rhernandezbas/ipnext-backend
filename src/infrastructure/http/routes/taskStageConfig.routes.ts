import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { GetTaskStageRecipientConfig } from '@application/use-cases/GetTaskStageRecipientConfig';
import { UpdateTaskStageRecipientConfig } from '@application/use-cases/UpdateTaskStageRecipientConfig';
import { GetTaskStageTransitionConfig } from '@application/use-cases/GetTaskStageTransitionConfig';
import { SetTaskStageTransitionConfig } from '@application/use-cases/SetTaskStageTransitionConfig';

/**
 * bulk-task-recipients (D6) + bulk-task-stage-transition (TTC-4) —
 * `/api/messaging/config/task-stages` router: config-CRUD del 5to dominio de
 * destinatarios del bulk WhatsApp ("Tarea"). Molde `createNocBroadcastRouter`.
 *
 * - `GET /` → `{ stages, resultingStage }`: QUÉ `Stage`s son elegibles (set) +
 *   el ÚNICO estado resultante global (bulk-task-stage-transition). Gate messaging:read.
 * - `PUT /` → replace-set del mapeo de elegibles. Gate messaging:manage.
 * - `PUT /resulting-stage` → setea/limpia el estado resultante global (valida
 *   existencia + prohíbe send_to_iclass en el use case). Gate messaging:manage.
 */
export interface TaskStageConfigRoutePerms {
  /** GET / — messaging:read. */
  read: RequestHandler;
  /** PUT / y PUT /resulting-stage — messaging:manage. */
  manage: RequestHandler;
}

/** PUT / body — replace-set del mapeo de elegibles. */
const UpdateTaskStageRecipientConfigSchema = z.object({
  stageIds: z.array(z.string()),
});

/** PUT /resulting-stage body — el destino único global (string o null para limpiar). */
const SetResultingStageSchema = z.object({
  stageId: z.string().nullable(),
});

export function createTaskStageConfigRouter(
  authProvider: AuthProvider,
  perms: TaskStageConfigRoutePerms,
  getTaskStageRecipientConfig: GetTaskStageRecipientConfig,
  updateTaskStageRecipientConfig: UpdateTaskStageRecipientConfig,
  getTaskStageTransitionConfig: GetTaskStageTransitionConfig,
  setTaskStageTransitionConfig: SetTaskStageTransitionConfig,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  // ─── GET / — mapeo actual + estado resultante (read) ────────────────────────
  router.get('/', auth, perms.read, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const [recipient, transition] = await Promise.all([
        getTaskStageRecipientConfig.execute(),
        getTaskStageTransitionConfig.execute(),
      ]);
      res.json({ ...recipient, ...transition }); // { stages, resultingStage }
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT / — replace-set de elegibles (manage) ──────────────────────────────
  router.put('/', auth, perms.manage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateTaskStageRecipientConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await updateTaskStageRecipientConfig.execute(parsed.data));
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT /resulting-stage — estado resultante único global (manage) ─────────
  // stageId inexistente → TaskStageNotFoundError (422); code send_to_iclass →
  // ResultingStageNotAllowedError (422) — ambos vía next(err) → errorHandler.
  router.put('/resulting-stage', auth, perms.manage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = SetResultingStageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await setTaskStageTransitionConfig.execute(parsed.data));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
