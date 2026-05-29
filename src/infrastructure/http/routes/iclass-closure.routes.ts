import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { SyncIClassResultCodes } from '@application/use-cases/SyncIClassResultCodes';
import { ListIClassResultCodes } from '@application/use-cases/ListIClassResultCodes';
import { AssignResultCodeStage } from '@application/use-cases/AssignResultCodeStage';
import { GetClosureStatus } from '@application/use-cases/GetClosureStatus';
import { toResultCodeDTO } from '@application/dto/iclassClosure.dto';

const ListQuerySchema = z.object({
  mapped: z.enum(['true', 'false']).optional().transform(v => (v === 'true' ? true : v === 'false' ? false : undefined)),
});

const AssignSchema = z.object({
  stageId: z.string().min(1).nullable(),
});

/**
 * Admin routes for the IClass closure loop. Mount at /api/admin/iclass.
 *
 *   POST  /result-codes/sync   — sync the result-code catalog from IClass
 *   GET   /result-codes        — list the catalog (?mapped=true|false)
 *   PATCH /result-codes/:id     — configure the closure mapping { stageId } (null clears)
 *   GET   /closure/status       — last closure-ingest run + counts
 */
export function createIClassClosureRouter(
  syncResultCodes: SyncIClassResultCodes,
  listResultCodes: ListIClassResultCodes,
  assignResultCodeStage: AssignResultCodeStage,
  getClosureStatus: GetClosureStatus,
  authProvider: AuthProvider,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.post('/result-codes/sync', auth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await syncResultCodes.execute());
    } catch (err) {
      next(err);
    }
  });

  router.get('/result-codes', auth, async (req: Request, res: Response): Promise<void> => {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    const filter = parsed.data.mapped !== undefined ? { mapped: parsed.data.mapped } : undefined;
    const items = (await listResultCodes.execute(filter)).map(toResultCodeDTO);
    res.status(200).json({ items });
  });

  router.patch('/result-codes/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = AssignSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const updated = await assignResultCodeStage.execute(req.params.id, parsed.data.stageId);
      res.status(200).json(toResultCodeDTO(updated));
    } catch (err) {
      next(err); // StageNotFoundError / IClassResultCodeNotFoundError → 404
    }
  });

  router.get('/closure/status', auth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await getClosureStatus.execute());
    } catch (err) {
      next(err);
    }
  });

  return router;
}
