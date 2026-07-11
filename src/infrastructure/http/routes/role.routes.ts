import { Router, Request, Response, NextFunction } from 'express';
import { ListRoles } from '@application/use-cases/ListRoles';
import { GetRole } from '@application/use-cases/GetRole';
import { CreateRole } from '@application/use-cases/CreateRole';
import { UpdateRole } from '@application/use-cases/UpdateRole';
import { DeleteRole } from '@application/use-cases/DeleteRole';
import { AdminRole_Definition } from '@domain/entities/role';

export function createRoleRouter(
  listRoles: ListRoles,
  getRole: GetRole,
  createRole: CreateRole,
  updateRole: UpdateRole,
  deleteRole: DeleteRole,
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const roles = await listRoles.execute();
      res.json(roles);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const role = await getRole.execute(req.params['id'] as string);
      if (!role) {
        res.status(404).json({ error: 'Role not found', code: 'ROLE_NOT_FOUND' });
        return;
      }
      res.json(role);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = req.body as Omit<AdminRole_Definition, 'id'>;
      const role = await createRole.execute(data);
      res.status(201).json(role);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const role = await updateRole.execute(req.params['id'] as string, req.body as Partial<AdminRole_Definition>);
      if (!role) {
        res.status(404).json({ error: 'Role not found', code: 'ROLE_NOT_FOUND' });
        return;
      }
      res.json(role);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const deleted = await deleteRole.execute(req.params['id'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'Role not found', code: 'ROLE_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
