/**
 * conversation-labels (Ola 5) — /api/messaging/labels: CRUD del catálogo de
 * etiquetas de conversación. Clon de `ticketAreas.routes.ts` (factory +
 * requirePerm inyectado, auth por ruta, try/catch → next(err)).
 *
 * Gates:
 *   - GET (list)             → messaging:read
 *   - POST/PUT/DELETE (mutar) → messaging:manage
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { ListLabels } from '@application/use-cases/messaging/ListLabels';
import { CreateLabel } from '@application/use-cases/messaging/CreateLabel';
import { UpdateLabel } from '@application/use-cases/messaging/UpdateLabel';
import { DeleteLabel } from '@application/use-cases/messaging/DeleteLabel';
import { CreateLabelSchema, UpdateLabelSchema } from '@application/dto/messaging-labels.dto';
import {
  ConversationLabelNotFoundError,
  ConversationLabelNameConflictError,
} from '@domain/errors/messaging';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

export function createMessagingLabelsRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  listLabels: ListLabels,
  createLabel: CreateLabel,
  updateLabel: UpdateLabel,
  deleteLabel: DeleteLabel,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider, sessionRepo);
  const readPerm = requirePerm('messaging', 'read');
  const managePerm = requirePerm('messaging', 'manage');

  router.get('/', auth, readPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await listLabels.execute());
    } catch (err) {
      next(err);
    }
  });

  router.post('/', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateLabelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.status(201).json(await createLabel.execute(parsed.data));
    } catch (err) {
      if (err instanceof ConversationLabelNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.put('/:id', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateLabelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await updateLabel.execute(req.params['id'] as string, parsed.data));
    } catch (err) {
      if (err instanceof ConversationLabelNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ConversationLabelNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.delete('/:id', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deleteLabel.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof ConversationLabelNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  return router;
}
