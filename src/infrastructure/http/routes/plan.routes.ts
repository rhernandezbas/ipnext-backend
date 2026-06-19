import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListPlans } from '@application/use-cases/ListPlans';
import { CreatePlan } from '@application/use-cases/CreatePlan';
import { UpdatePlan } from '@application/use-cases/UpdatePlan';
import { DeletePlan } from '@application/use-cases/DeletePlan';
import { CreatePlanBodySchema, UpdatePlanBodySchema, toPlanDto } from '@application/dto/plan.dto';
import { PlanCodeTakenError, PlanNotFoundError } from '@domain/errors/plan';

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

export function createPlanRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  listPlans: ListPlans,
  createPlan: CreatePlan,
  updatePlan: UpdatePlan,
  deletePlan: DeletePlan,
): Router {
  const router = Router();
  const auth      = createAuthMiddleware(authProvider, sessionRepo);
  const canRead   = requirePerm('plan', 'read');
  const canManage = requirePerm('plan', 'manage');

  router.get('/plans', auth, canRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const plans = await listPlans.execute();
      res.json(plans.map(toPlanDto));
    } catch (err) {
      next(err);
    }
  });

  router.post('/plans', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreatePlanBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const plan = await createPlan.execute(parsed.data);
      res.status(201).json(toPlanDto(plan));
    } catch (err) {
      if (err instanceof PlanCodeTakenError) {
        res.status(409).json({ code: err.code, error: err.message });
        return;
      }
      next(err);
    }
  });

  router.patch('/plans/:id', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdatePlanBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const plan = await updatePlan.execute({ id: req.params['id'] as string, ...parsed.data });
      res.json(toPlanDto(plan));
    } catch (err) {
      if (err instanceof PlanNotFoundError) {
        res.status(404).json({ code: err.code, error: err.message });
        return;
      }
      next(err);
    }
  });

  router.delete('/plans/:id', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deletePlan.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof PlanNotFoundError) {
        res.status(404).json({ code: err.code, error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}
