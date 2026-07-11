import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListTicketAreas } from '@application/use-cases/ListTicketAreas';
import { GetTicketArea } from '@application/use-cases/GetTicketArea';
import { CreateTicketArea } from '@application/use-cases/CreateTicketArea';
import { UpdateTicketArea } from '@application/use-cases/UpdateTicketArea';
import { DeleteTicketArea } from '@application/use-cases/DeleteTicketArea';
import { CreateTicketAreaSchema, UpdateTicketAreaSchema } from '@application/dto/tickets.dto';
import {
  TicketAreaNotFoundError,
  TicketAreaNameConflictError,
  TicketAreaInUseError,
} from '@domain/errors/tickets';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

export function createTicketAreasRouter(
  authProvider: AuthProvider,
  requirePerm: RequirePerm,
  listTicketAreas: ListTicketAreas,
  getTicketArea: GetTicketArea,
  createTicketArea: CreateTicketArea,
  updateTicketArea: UpdateTicketArea,
  deleteTicketArea: DeleteTicketArea,
): Router {
  const router = Router();
  const auth       = createAuthMiddleware(authProvider);
  const readPerm   = requirePerm('tickets', 'read');
  const managePerm = requirePerm('tickets', 'manage');

  router.get('/', auth, readPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await listTicketAreas.execute());
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', auth, readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getTicketArea.execute(req.params['id'] as string));
    } catch (err) {
      if (err instanceof TicketAreaNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.post('/', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateTicketAreaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.status(201).json(await createTicketArea.execute(parsed.data));
    } catch (err) {
      if (err instanceof TicketAreaNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.put('/:id', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateTicketAreaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await updateTicketArea.execute(req.params['id'] as string, parsed.data));
    } catch (err) {
      if (err instanceof TicketAreaNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof TicketAreaNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.delete('/:id', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deleteTicketArea.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof TicketAreaNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof TicketAreaInUseError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  return router;
}
