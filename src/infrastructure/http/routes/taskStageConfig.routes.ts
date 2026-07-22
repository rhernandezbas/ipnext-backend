import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { GetTaskStageRecipientConfig } from '@application/use-cases/GetTaskStageRecipientConfig';
import { UpdateTaskStageRecipientConfig } from '@application/use-cases/UpdateTaskStageRecipientConfig';

/**
 * bulk-task-recipients (D6, TSC-3, TSC-4) — `/api/messaging/config/task-stages`
 * router: config-CRUD del 5to dominio de destinatarios del bulk WhatsApp
 * ("Tarea") — QUÉ `Stage`s son elegibles como criterio. Molde
 * `createNocBroadcastRouter`/`nocBroadcast.routes.ts:30-76` (factory +
 * authProvider, Zod `safeParse` → 400 VALIDATION_ERROR, try/catch →
 * next(err) → errorHandler global).
 *
 * RBAC: GET = messaging:read (lo leen la card de Ajustes Y el tab "Tarea" del
 * composer); PUT = messaging:manage (solo supervisores editan el mapeo) —
 * mismo par "supervisor" que noc-broadcast/canned-responses.
 */
export interface TaskStageConfigRoutePerms {
  /** GET / — messaging:read. */
  read: RequestHandler;
  /** PUT / — messaging:manage. */
  manage: RequestHandler;
}

/** PUT / body — replace-set del mapeo. */
const UpdateTaskStageRecipientConfigSchema = z.object({
  stageIds: z.array(z.string()),
});

export function createTaskStageConfigRouter(
  authProvider: AuthProvider,
  perms: TaskStageConfigRoutePerms,
  getTaskStageRecipientConfig: GetTaskStageRecipientConfig,
  updateTaskStageRecipientConfig: UpdateTaskStageRecipientConfig,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  // ─── GET / — mapeo actual (read) ────────────────────────────────────────────
  router.get('/', auth, perms.read, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getTaskStageRecipientConfig.execute());
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT / — replace-set (manage) ───────────────────────────────────────────
  // stageId inexistente: el error tipado (TaskStageNotFoundError, TASK_STAGE_NOT_FOUND)
  // lo lanza el repo (D2, transacción atómica) y llega acá vía next(err) → 422
  // (errorHandler statusMap) — sin chequeo de existencia redundante en esta ruta.
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

  return router;
}
