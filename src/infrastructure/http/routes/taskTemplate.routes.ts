import { Router, Request, Response } from 'express';
import { ListTaskTemplates } from '@application/use-cases/ListTaskTemplates';
import { GetTaskTemplate } from '@application/use-cases/GetTaskTemplate';
import { CreateTaskTemplate } from '@application/use-cases/CreateTaskTemplate';
import { UpdateTaskTemplate } from '@application/use-cases/UpdateTaskTemplate';
import { DeleteTaskTemplate } from '@application/use-cases/DeleteTaskTemplate';
import { TaskTemplate } from '@domain/entities/taskTemplate';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { CreateTaskTemplateSchema, UpdateTaskTemplateSchema } from '@application/dto/taskTemplate.dto';

export function createTaskTemplateRouter(
  listTemplates: ListTaskTemplates,
  getTemplate: GetTaskTemplate,
  createTemplate: CreateTaskTemplate,
  updateTemplate: UpdateTaskTemplate,
  deleteTemplate: DeleteTaskTemplate,
  authProvider: AuthProvider,
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

  return router;
}
