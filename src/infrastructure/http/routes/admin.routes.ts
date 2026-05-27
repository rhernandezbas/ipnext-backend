import { Router, Request, Response } from 'express';
import { ListAdmins } from '@application/use-cases/ListAdmins';
import { GetAdmin } from '@application/use-cases/GetAdmin';
import { CreateAdmin } from '@application/use-cases/CreateAdmin';
import { UpdateAdmin } from '@application/use-cases/UpdateAdmin';
import { DeleteAdmin } from '@application/use-cases/DeleteAdmin';
import { GetAdminActivityLog } from '@application/use-cases/GetAdminActivityLog';
import { Get2FAStatus } from '@application/use-cases/Get2FAStatus';
import { Enable2FA } from '@application/use-cases/Enable2FA';
import { Disable2FA } from '@application/use-cases/Disable2FA';

export function createAdminRouter(
  listAdmins: ListAdmins,
  getAdmin: GetAdmin,
  createAdmin: CreateAdmin,
  updateAdmin: UpdateAdmin,
  deleteAdmin: DeleteAdmin,
  getActivityLog: GetAdminActivityLog,
  get2FAStatus?: Get2FAStatus,
  enable2FA?: Enable2FA,
  disable2FA?: Disable2FA,
): Router {
  const router = Router();

  // NOTE: /activity-log MUST be registered before /:id to avoid route conflict
  router.get('/activity-log', async (req: Request, res: Response): Promise<void> => {
    const { category } = req.query as { category?: import('@domain/entities/admin').ActivityCategory };
    const log = await getActivityLog.execute(category);
    res.json(log);
  });

  router.get('/', async (req: Request, res: Response): Promise<void> => {
    const role = typeof req.query['role'] === 'string' ? req.query['role'] : undefined;
    const admins = await listAdmins.execute(role);
    res.json(admins);
  });

  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const admin = await getAdmin.execute(req.params['id'] as string);
    if (!admin) {
      res.status(404).json({ error: 'Admin not found', code: 'ADMIN_NOT_FOUND' });
      return;
    }
    res.json(admin);
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const { name, email, role, status, password } = req.body as {
      name?: string;
      email?: string;
      role?: string;
      status?: 'active' | 'inactive';
      password?: string;
    };

    if (!name || !email || !role || !status || !password) {
      res.status(400).json({
        error: 'Missing required fields: name, email, role, status, password',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const admin = await createAdmin.execute({ name, email, role, status, password });
    res.status(201).json(admin);
  });

  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    const admin = await updateAdmin.execute(req.params['id'] as string, req.body as Partial<import('@domain/entities/admin').Admin>);
    if (!admin) {
      res.status(404).json({ error: 'Admin not found', code: 'ADMIN_NOT_FOUND' });
      return;
    }
    res.json(admin);
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteAdmin.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Admin not found', code: 'ADMIN_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  // 2FA routes — must be before /:id to avoid conflict
  if (get2FAStatus) {
    router.get('/:id/2fa', async (req: Request, res: Response): Promise<void> => {
      const status = await get2FAStatus.execute(req.params['id'] as string);
      res.json(status);
    });
  }

  if (enable2FA) {
    router.post('/:id/2fa/enable', async (req: Request, res: Response): Promise<void> => {
      const { method } = req.body as { method: 'totp' | 'sms' };
      const result = await enable2FA.execute(req.params['id'] as string, method);
      res.json(result);
    });
  }

  if (disable2FA) {
    router.delete('/:id/2fa', async (req: Request, res: Response): Promise<void> => {
      await disable2FA.execute(req.params['id'] as string);
      res.json({ success: true });
    });
  }

  return router;
}
