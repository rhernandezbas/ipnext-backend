import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { ReferenceNotFoundError, ReferenceKind, ProjectHasActiveTasksError } from '@domain/errors/projects';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { CreateProjectSchema, PutProjectSchema, UpdateProjectSchema, ListProjectsQuerySchema } from '@application/dto/projects.dto';
import { ListProjects } from '@application/use-cases/ListProjects';
import { GetProject } from '@application/use-cases/GetProject';
import { CreateProject } from '@application/use-cases/CreateProject';
import { UpdateProject } from '@application/use-cases/UpdateProject';
import { DeleteProject } from '@application/use-cases/DeleteProject';
import { AssignIClassSoTypeToProject } from '@application/use-cases/AssignIClassSoTypeToProject';

const REFERENCE_TO_CODE: Record<ReferenceKind, string> = {
  category: 'CATEGORY_NOT_FOUND',
  type:     'TYPE_NOT_FOUND',
  workflow: 'WORKFLOW_NOT_FOUND',
  lead:     'LEAD_NOT_FOUND',
  partner:  'PARTNER_NOT_FOUND',
};

export function createProjectsRouter(
  listProjects: ListProjects,
  getProject: GetProject,
  createProject: CreateProject,
  updateProject: UpdateProject,
  deleteProject: DeleteProject,
  authProvider: AuthProvider,
  assignIClassSoType?: AssignIClassSoTypeToProject,
  /** Guard for the `allowsEquipmentRetirement` mutation (inventory.manage). Pass-through when omitted. */
  requireInventoryManage?: RequestHandler,
  /** #40 — Guard for the `isNetworkProject` mutation (scheduling.manage). Pass-through when omitted. */
  requireSchedulingManage?: RequestHandler,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);
  const invManage: RequestHandler = requireInventoryManage ?? ((_req, _res, next) => next());
  const schedManage: RequestHandler = requireSchedulingManage ?? ((_req, _res, next) => next());

  router.get('/', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ListProjectsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      // Default behaviour: only return enabled projects. Callers must opt in to
      // see disabled projects with ?visible=false, or pass ?visible=all to get
      // everything (for restore-aware UIs).
      let filter: { visible?: boolean } | undefined;
      if (parsed.data.visible === undefined) {
        filter = { visible: true };
      } else if (parsed.data.visible === 'all') {
        filter = undefined;
      } else {
        filter = { visible: parsed.data.visible === 'true' };
      }
      const projects = await listProjects.execute(filter);
      res.json(projects);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const project = await getProject.execute(req.params['id'] as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
        return;
      }
      res.json(project);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const project = await createProject.execute(parsed.data);
      res.status(201).json(project);
    } catch (err) {
      if (err instanceof ReferenceNotFoundError) {
        res.status(404).json({ error: err.message, code: REFERENCE_TO_CODE[err.reference] });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.put('/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // PUT uses PutProjectSchema — deliberately excludes allowsEquipmentRetirement
    // to prevent a privilege-escalation back-door (that field is PATCH-only, guarded).
    const parsed = PutProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const { iclassSoTypeId, ...rest } = parsed.data;

      // If iclassSoTypeId is explicitly present (including null), handle the assignment first.
      if ('iclassSoTypeId' in parsed.data && assignIClassSoType !== undefined) {
        const updated = await assignIClassSoType.execute(req.params['id'] as string, iclassSoTypeId ?? null);
        // If only iclassSoTypeId was sent, we're done
        if (Object.keys(rest).length === 0) {
          res.json(updated);
          return;
        }
      }

      const project = await updateProject.execute(req.params['id'] as string, rest);
      if (!project) {
        res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
        return;
      }
      res.json(project);
    } catch (err) {
      if (err instanceof ReferenceNotFoundError) {
        res.status(404).json({ error: err.message, code: REFERENCE_TO_CODE[err.reference] });
        return;
      }
      next(err);
    }
  });

  /**
   * requireManageForRetirementFlag — inline middleware that gates `invManage` only
   * when `allowsEquipmentRetirement` is present in the request body.
   * Using a real middleware (not a promise wrapper) ensures next(err) propagates
   * correctly to the error handler and the deny-path never hangs.
   */
  const requireManageForRetirementFlag: RequestHandler = (req, res, next) => {
    if (req.body != null && 'allowsEquipmentRetirement' in req.body) {
      return invManage(req, res, next);
    }
    return next();
  };

  /**
   * #40 — requireManageForNetworkFlag — gates schedManage only when
   * `isNetworkProject` is present in the request body. Mirror of
   * requireManageForRetirementFlag. Using a real middleware (not a promise
   * wrapper) ensures next(err) propagates correctly to the error handler.
   */
  const requireManageForNetworkFlag: RequestHandler = (req, res, next) => {
    if (req.body != null && 'isNetworkProject' in req.body) {
      return schedManage(req, res, next);
    }
    return next();
  };

  router.patch('/:id', auth, requireManageForRetirementFlag, requireManageForNetworkFlag, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }

    try {
      const { iclassSoTypeId, ...rest } = parsed.data;

      // If iclassSoTypeId is explicitly present (including null), handle the assignment first.
      if ('iclassSoTypeId' in parsed.data && assignIClassSoType !== undefined) {
        const updated = await assignIClassSoType.execute(req.params['id'] as string, iclassSoTypeId ?? null);
        // If only iclassSoTypeId was sent, we're done
        if (Object.keys(rest).length === 0) {
          res.json(updated);
          return;
        }
      }

      const project = await updateProject.execute(req.params['id'] as string, rest);
      if (!project) {
        res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
        return;
      }
      res.json(project);
    } catch (err) {
      if (err instanceof ReferenceNotFoundError) {
        res.status(404).json({ error: err.message, code: REFERENCE_TO_CODE[err.reference] });
        return;
      }
      next(err);
    }
  });

  router.delete('/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const deleted = await deleteProject.execute(req.params['id'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      if (err instanceof ProjectHasActiveTasksError) {
        res.status(409).json({
          error: 'Project has active tasks (nuevo / enProgreso). Close or cancel them before disabling the project.',
          code: err.code,
          details: err.activeCounts,
        });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  return router;
}
