import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { SyncIClassResultCodes } from '@application/use-cases/SyncIClassResultCodes';
import { ListIClassResultCodes } from '@application/use-cases/ListIClassResultCodes';
import { AssignResultCodeStage } from '@application/use-cases/AssignResultCodeStage';
import { GetClosureStatus } from '@application/use-cases/GetClosureStatus';
import { BackfillClosedServiceOrders } from '@application/use-cases/BackfillClosedServiceOrders';
import { GetPendingSideEffectsCount } from '@application/use-cases/GetPendingSideEffectsCount';
import { GetPendingSideEffectsList } from '@application/use-cases/GetPendingSideEffectsList';
import { GetIClassClosureConfig } from '@application/use-cases/GetIClassClosureConfig';
import { UpdateIClassClosureConfig } from '@application/use-cases/UpdateIClassClosureConfig';
import { TaskAutocompleteScheduler } from '@infrastructure/scheduling/TaskAutocompleteScheduler';
import { toResultCodeDTO, UpdateIClassClosureConfigSchema } from '@application/dto/iclassClosure.dto';

const ListQuerySchema = z.object({
  mapped: z.enum(['true', 'false']).optional().transform(v => (v === 'true' ? true : v === 'false' ? false : undefined)),
});

const AssignSchema = z.object({
  stageId: z.string().min(1).nullable(),
});

/**
 * Admin routes for the IClass closure loop. Mount at /api/admin/iclass.
 *
 *   POST  /result-codes/sync             — sync the result-code catalog from IClass
 *   GET   /result-codes                  — list the catalog (?mapped=true|false)
 *   PATCH /result-codes/:id              — configure the closure mapping { stageId } (null clears)
 *   GET   /closure/status                — last closure-ingest run + counts
 *   POST  /closure/backfill              — reconcile in-flight tasks against IClass now
 *   POST  /closure/reprocess             — async dispatch via scheduler (flag-gated, 202)
 *   GET   /closure/reprocess/pending-count — count of SOs with pending side-effects
 *   GET   /closure/reprocess/pending-list  — list of SOs with pending side-effects + joined task info
 *   GET   /closure/config               — get persisted scheduler intervals (iclass:manage)
 *   PUT   /closure/config               — update scheduler intervals (iclass:manage)
 */
export function createIClassClosureRouter(
  syncResultCodes: SyncIClassResultCodes,
  listResultCodes: ListIClassResultCodes,
  assignResultCodeStage: AssignResultCodeStage,
  getClosureStatus: GetClosureStatus,
  backfillClosedOrders: BackfillClosedServiceOrders,
  scheduler: TaskAutocompleteScheduler | null,
  getPendingCount: GetPendingSideEffectsCount,
  getPendingList: GetPendingSideEffectsList,
  getConfig: GetIClassClosureConfig,
  updateConfig: UpdateIClassClosureConfig,
  requireIClassManage: RequestHandler,
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

  // On-demand reconcile of in-flight tasks (sent to IClass, awaiting closure).
  // Idempotent — safe to run repeatedly. Returns the run counts.
  router.post('/closure/backfill', auth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await backfillClosedOrders.execute());
    } catch (err) {
      next(err);
    }
  });

  // Disparo manual de reprocess: delega al scheduler para respuesta inmediata (202).
  // El trabajo real (OCR/audit/comment) corre en segundo plano.
  // 503 cuando el scheduler no está disponible (credenciales IClass ausentes).
  router.post('/closure/reprocess', auth, requireIClassManage, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!scheduler) {
        res.status(503).json({ reason: 'unavailable' });
        return;
      }
      const result = await scheduler.triggerNow();
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Endpoint de progreso: cantidad de SOs con al menos un side-effect pendiente.
  // El FE lo usa para mostrar el progreso del reprocess (polling cada 5s).
  router.get('/closure/reprocess/pending-count', auth, requireIClassManage, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await getPendingCount.execute());
    } catch (err) {
      next(err);
    }
  });

  // Listado enriquecido: cada SO pendiente con la info de la tarea vinculada.
  // El FE lo usa para renderizar la tabla de progreso del reprocess.
  router.get('/closure/reprocess/pending-list', auth, requireIClassManage, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await getPendingList.execute());
    } catch (err) {
      next(err);
    }
  });

  // Persisted scheduler interval config — read ONCE at startup, change takes effect after restart.
  router.get('/closure/config', auth, requireIClassManage, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await getConfig.execute());
    } catch (err) {
      next(err);
    }
  });

  router.put('/closure/config', auth, requireIClassManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateIClassClosureConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.status(200).json(await updateConfig.execute(parsed.data));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
