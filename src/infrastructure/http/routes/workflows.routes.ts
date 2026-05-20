import { Router, Request, Response } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
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

export function createWorkflowsRouter(
  authProvider: AuthProvider,
  listWorkflows: ListWorkflows,
  getWorkflow: GetWorkflow,
  createWorkflow: CreateWorkflow,
  updateWorkflow: UpdateWorkflow,
  deleteWorkflow: DeleteWorkflow,
  addStageToWorkflow: AddStageToWorkflow,
  removeStageFromWorkflow: RemoveStageFromWorkflow,
  reorderStages: ReorderStages,
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

  // ─── Workflows ────────────────────────────────────────────────────────────

  router.get('/workflows', auth, async (_req: Request, res: Response): Promise<void> => {
    const workflows = await listWorkflows.execute();
    res.json(workflows);
  });

  router.get('/workflows/:id', auth, async (req: Request, res: Response): Promise<void> => {
    try {
      const wf = await getWorkflow.execute(req.params['id'] as string);
      res.json(wf);
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  router.post('/workflows', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  router.put('/workflows/:id', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  router.delete('/workflows/:id', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  // ─── Stages ───────────────────────────────────────────────────────────────

  router.post('/workflows/:id/stages', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  router.put('/workflows/:id/stages/reorder', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  router.delete('/workflows/:id/stages/:stageId', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  // ─── ProjectCategory ──────────────────────────────────────────────────────

  router.get('/project-categories', auth, async (_req: Request, res: Response): Promise<void> => {
    const items = await listProjectCategory.execute();
    res.json(items);
  });

  router.get('/project-categories/:id', auth, async (req: Request, res: Response): Promise<void> => {
    try {
      const item = await getProjectCategory.execute(req.params['id'] as string);
      res.json(item);
    } catch (err) {
      if (err instanceof ProjectCategoryNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  router.post('/project-categories', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  router.put('/project-categories/:id', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  router.delete('/project-categories/:id', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  // ─── ProjectType ──────────────────────────────────────────────────────────

  router.get('/project-types', auth, async (_req: Request, res: Response): Promise<void> => {
    const items = await listProjectType.execute();
    res.json(items);
  });

  router.get('/project-types/:id', auth, async (req: Request, res: Response): Promise<void> => {
    try {
      const item = await getProjectType.execute(req.params['id'] as string);
      res.json(item);
    } catch (err) {
      if (err instanceof ProjectTypeNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  router.post('/project-types', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  router.put('/project-types/:id', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  router.delete('/project-types/:id', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  return router;
}
