import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import {
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  CreateStageSchema,
  ReorderStagesSchema,
  CreateProjectCategorySchema,
  UpdateProjectCategorySchema,
  CreateProjectTypeSchema,
  UpdateProjectTypeSchema,
} from '@application/dto/workflows.dto';
import { ListWorkflows } from '@application/use-cases/ListWorkflows';
import { GetWorkflow } from '@application/use-cases/GetWorkflow';
import { CreateWorkflow } from '@application/use-cases/CreateWorkflow';
import { UpdateWorkflow } from '@application/use-cases/UpdateWorkflow';
import { DeleteWorkflow } from '@application/use-cases/DeleteWorkflow';
import { AddStageToWorkflow } from '@application/use-cases/AddStageToWorkflow';
import { UpdateStageColor } from '@application/use-cases/UpdateStageColor';
import { UpdateStage } from '@application/use-cases/UpdateStage';
import { RemoveStageFromWorkflow } from '@application/use-cases/RemoveStageFromWorkflow';
import { ReorderStages } from '@application/use-cases/ReorderStages';
import { ListProjectCategory } from '@application/use-cases/ListProjectCategory';
import { GetProjectCategory } from '@application/use-cases/GetProjectCategory';
import { CreateProjectCategory } from '@application/use-cases/CreateProjectCategory';
import { UpdateProjectCategory } from '@application/use-cases/UpdateProjectCategory';
import { DeleteProjectCategory } from '@application/use-cases/DeleteProjectCategory';
import { ListProjectType } from '@application/use-cases/ListProjectType';
import { GetProjectType } from '@application/use-cases/GetProjectType';
import { CreateProjectType } from '@application/use-cases/CreateProjectType';
import { UpdateProjectType } from '@application/use-cases/UpdateProjectType';
import { DeleteProjectType } from '@application/use-cases/DeleteProjectType';
import {
  WorkflowNotFoundError,
  WorkflowNameConflictError,
  DefaultWorkflowProtectedError,
  WorkflowInUseError,
  StageNotFoundError,
  StageNameConflictError,
  StageInUseError,
  ReorderSetMismatchError,
  ProjectCategoryNotFoundError,
  ProjectCategoryNameConflictError,
  ProjectCategoryInUseError,
  ProjectTypeNotFoundError,
  ProjectTypeNameConflictError,
  ProjectTypeInUseError,
} from '@domain/errors/scheduling';
import type { StageCategory } from '@domain/entities/workflow';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

export function createWorkflowsRouter(
  authProvider: AuthProvider,
  requirePerm: RequirePerm,
  listWorkflows: ListWorkflows,
  getWorkflow: GetWorkflow,
  createWorkflow: CreateWorkflow,
  updateWorkflow: UpdateWorkflow,
  deleteWorkflow: DeleteWorkflow,
  addStageToWorkflow: AddStageToWorkflow,
  removeStageFromWorkflow: RemoveStageFromWorkflow,
  reorderStages: ReorderStages,
  updateStageColor: UpdateStageColor,
  updateStage: UpdateStage,
  listProjectCategory: ListProjectCategory,
  getProjectCategory: GetProjectCategory,
  createProjectCategory: CreateProjectCategory,
  updateProjectCategory: UpdateProjectCategory,
  deleteProjectCategory: DeleteProjectCategory,
  listProjectType: ListProjectType,
  getProjectType: GetProjectType,
  createProjectType: CreateProjectType,
  updateProjectType: UpdateProjectType,
  deleteProjectType: DeleteProjectType,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);
  const canRead   = requirePerm('scheduling', 'read');
  const canManage = requirePerm('scheduling', 'manage');

  // ─── Workflows ────────────────────────────────────────────────────────────

  router.get('/workflows', auth, canRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workflows = await listWorkflows.execute();
      res.json(workflows);
    } catch (err) {
      next(err);
    }
  });

  router.get('/workflows/:id', auth, canRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const wf = await getWorkflow.execute(req.params['id'] as string);
      res.json(wf);
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.post('/workflows', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateWorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const wf = await createWorkflow.execute(parsed.data);
      res.status(201).json(wf);
    } catch (err) {
      if (err instanceof WorkflowNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.put('/workflows/:id', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateWorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const wf = await updateWorkflow.execute(req.params['id'] as string, parsed.data);
      res.json(wf);
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof WorkflowNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.delete('/workflows/:id', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deleteWorkflow.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof DefaultWorkflowProtectedError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof WorkflowInUseError) {
        res.status(409).json({ error: err.message, code: err.code, details: { taskCount: err.taskCount } });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  // ─── Stages ───────────────────────────────────────────────────────────────

  router.post('/workflows/:id/stages', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateStageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const stage = await addStageToWorkflow.execute(req.params['id'] as string, parsed.data);
      res.status(201).json(stage);
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof StageNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.put('/workflows/:id/stages/reorder', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = ReorderStagesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const wf = await reorderStages.execute(req.params['id'] as string, parsed.data.order);
      res.json(wf);
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ReorderSetMismatchError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.delete('/workflows/:id/stages/:stageId', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await removeStageFromWorkflow.execute(req.params['id'] as string, req.params['stageId'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof StageNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof StageInUseError) {
        res.status(409).json({ error: err.message, code: err.code, details: { taskCount: err.taskCount } });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.patch('/workflows/:id/stages/:stageId/color', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { color } = req.body as { color?: string };
    if (!color || typeof color !== 'string') {
      res.status(400).json({ error: 'color is required', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const stage = await updateStageColor.execute(req.params['stageId'] as string, color);
      res.json(stage);
    } catch (err) {
      if (err instanceof StageNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.patch('/workflows/:id/stages/:stageId', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const VALID_CATEGORIES: StageCategory[] = ['nuevo', 'enProgreso', 'hecho'];
    const body = req.body as { name?: unknown; category?: unknown };
    const hasName     = body.name !== undefined;
    const hasCategory = body.category !== undefined;

    // Must send at least one of name or category
    if (!hasName && !hasCategory) {
      res.status(400).json({ error: 'At least one of name or category is required', code: 'VALIDATION_ERROR' });
      return;
    }
    // Validate name
    if (hasName && (typeof body.name !== 'string' || body.name.trim() === '')) {
      res.status(400).json({ error: 'name must be a non-empty string', code: 'VALIDATION_ERROR' });
      return;
    }
    // Validate category
    if (hasCategory && !VALID_CATEGORIES.includes(body.category as StageCategory)) {
      res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}`, code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      const stage = await updateStage.execute(req.params['stageId'] as string, {
        name:     hasName     ? (body.name as string) : undefined,
        category: hasCategory ? (body.category as StageCategory) : undefined,
      });
      res.json(stage);
    } catch (err) {
      if (err instanceof StageNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof StageNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  // ─── ProjectCategory ──────────────────────────────────────────────────────

  router.get('/project-categories', auth, canRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const items = await listProjectCategory.execute();
      res.json(items);
    } catch (err) {
      next(err);
    }
  });

  router.get('/project-categories/:id', auth, canRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const item = await getProjectCategory.execute(req.params['id'] as string);
      res.json(item);
    } catch (err) {
      if (err instanceof ProjectCategoryNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.post('/project-categories', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateProjectCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const item = await createProjectCategory.execute(parsed.data);
      res.status(201).json(item);
    } catch (err) {
      if (err instanceof ProjectCategoryNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.put('/project-categories/:id', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateProjectCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const item = await updateProjectCategory.execute(req.params['id'] as string, parsed.data);
      res.json(item);
    } catch (err) {
      if (err instanceof ProjectCategoryNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ProjectCategoryNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.delete('/project-categories/:id', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deleteProjectCategory.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof ProjectCategoryNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ProjectCategoryInUseError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  // ─── ProjectType ──────────────────────────────────────────────────────────

  router.get('/project-types', auth, canRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const items = await listProjectType.execute();
      res.json(items);
    } catch (err) {
      next(err);
    }
  });

  router.get('/project-types/:id', auth, canRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const item = await getProjectType.execute(req.params['id'] as string);
      res.json(item);
    } catch (err) {
      if (err instanceof ProjectTypeNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.post('/project-types', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateProjectTypeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const item = await createProjectType.execute(parsed.data);
      res.status(201).json(item);
    } catch (err) {
      if (err instanceof ProjectTypeNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.put('/project-types/:id', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateProjectTypeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const item = await updateProjectType.execute(req.params['id'] as string, parsed.data);
      res.json(item);
    } catch (err) {
      if (err instanceof ProjectTypeNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ProjectTypeNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.delete('/project-types/:id', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deleteProjectType.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof ProjectTypeNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ProjectTypeInUseError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  return router;
}
