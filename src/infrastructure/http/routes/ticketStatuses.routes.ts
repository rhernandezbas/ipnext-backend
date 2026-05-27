import { Router, Request, Response } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListTicketStatuses } from '@application/use-cases/ListTicketStatuses';
import { GetTicketStatus } from '@application/use-cases/GetTicketStatus';
import { CreateTicketStatus } from '@application/use-cases/CreateTicketStatus';
import { UpdateTicketStatusCatalog } from '@application/use-cases/UpdateTicketStatusCatalog';
import { DeleteTicketStatus } from '@application/use-cases/DeleteTicketStatus';
import { CreateTicketStatusSchema, UpdateTicketStatusSchema } from '@application/dto/tickets.dto';
import {
  TicketStatusNotFoundError,
  TicketStatusNameConflictError,
  TicketStatusInUseError,
} from '@domain/errors/tickets';

export function createTicketStatusesRouter(
  authProvider: AuthProvider,
  listTicketStatuses: ListTicketStatuses,
  getTicketStatus: GetTicketStatus,
  createTicketStatus: CreateTicketStatus,
  updateTicketStatusCatalog: UpdateTicketStatusCatalog,
  deleteTicketStatus: DeleteTicketStatus,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/', auth, async (_req: Request, res: Response): Promise<void> => {
    res.json(await listTicketStatuses.execute());
  });

  router.get('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await getTicketStatus.execute(req.params['id'] as string));
    } catch (err) {
      if (err instanceof TicketStatusNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  router.post('/', auth, async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateTicketStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.status(201).json(await createTicketStatus.execute(parsed.data));
    } catch (err) {
      if (err instanceof TicketStatusNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  router.put('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateTicketStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await updateTicketStatusCatalog.execute(req.params['id'] as string, parsed.data));
    } catch (err) {
      if (err instanceof TicketStatusNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof TicketStatusNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  router.delete('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    try {
      await deleteTicketStatus.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof TicketStatusNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof TicketStatusInUseError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  return router;
}
