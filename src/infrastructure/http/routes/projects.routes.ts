import { Router, Request, Response } from 'express';
import { ProjectRepository } from '@domain/ports/ProjectRepository';

export function createProjectsRouter(repo: ProjectRepository): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    const projects = await repo.list();
    res.json(projects);
  });

  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const project = await repo.get(req.params['id'] as string);
    if (!project) {
      res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      return;
    }
    res.json(project);
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const { title, description } = req.body as { title: string; description?: string };
    if (!title?.trim()) {
      res.status(400).json({ error: 'Title is required', code: 'VALIDATION_ERROR' });
      return;
    }
    const project = await repo.create({ title: title.trim(), description: description ?? null });
    res.status(201).json(project);
  });

  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    const { title, description } = req.body as { title?: string; description?: string };
    const project = await repo.update(req.params['id'] as string, { title, description });
    if (!project) {
      res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      return;
    }
    res.json(project);
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await repo.delete(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
