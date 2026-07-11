import { Router, Request, Response, NextFunction } from 'express';
import { ListTaskTemplates } from '@application/use-cases/ListTaskTemplates';
import { GetTaskTemplate } from '@application/use-cases/GetTaskTemplate';
import { CreateTaskTemplate } from '@application/use-cases/CreateTaskTemplate';
import { UpdateTaskTemplate } from '@application/use-cases/UpdateTaskTemplate';
import { DeleteTaskTemplate } from '@application/use-cases/DeleteTaskTemplate';
import { ReplaceTaskTemplateItems } from '@application/use-cases/ReplaceTaskTemplateItems';
import { TaskTemplate } from '@domain/entities/taskTemplate';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { CreateTaskTemplateSchema, UpdateTaskTemplateSchema } from '@application/dto/taskTemplate.dto';
import { ReplaceTemplateItemsSchema } from '@application/dto/checklists.dto';
import { TemplateNotFoundError } from '@domain/errors/checklist';

export function createTaskTemplateRouter(
  listTemplates: ListTaskTemplates,
  getTemplate: GetTaskTemplate,
  createTemplate: CreateTaskTemplate,
  updateTemplate: UpdateTaskTemplate,
  deleteTemplate: DeleteTaskTemplate,
  authProvider: AuthProvider,
  replaceTemplateItems?: ReplaceTaskTemplateItems,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/', auth, async (_req: Request, res: Response): Promise<void> => {
    const templates = await listTemplates.execute();
    res.json(templates);
  });

  router.get('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const template = await getTemplate.execute(req.params['id'] as string);
    if (!template) {
      res.status(404).json({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
      return;
    }
    res.json(template);
  });

  router.post('/', auth, async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateTaskTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    const template = await createTemplate.execute(parsed.data as Omit<TaskTemplate, 'id'>);
    res.status(201).json(template);
  });

  router.put('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateTaskTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    const template = await updateTemplate.execute(req.params['id'] as string, parsed.data as Partial<TaskTemplate>);
    if (!template) {
      res.status(404).json({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
      return;
    }
    res.json(template);
  });

  router.delete('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteTemplate.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  // NEW: replace-set template items
  if (replaceTemplateItems) {
    router.put('/:id/items', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = ReplaceTemplateItemsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const items = await replaceTemplateItems.execute(req.params['id'] as string, parsed.data.items);
        res.json(items);
      } catch (err) {
        if (err instanceof TemplateNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
        next(err);
      }
    });
  }

  return router;
}
