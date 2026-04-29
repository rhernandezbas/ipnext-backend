import { Router, Request, Response } from 'express';
import { ListTr069Profiles } from '@application/use-cases/ListTr069Profiles';
import { CreateTr069Profile } from '@application/use-cases/CreateTr069Profile';
import { UpdateTr069Profile } from '@application/use-cases/UpdateTr069Profile';
import { DeleteTr069Profile } from '@application/use-cases/DeleteTr069Profile';
import { ListTr069Devices } from '@application/use-cases/ListTr069Devices';
import { ProvisionDevice } from '@application/use-cases/ProvisionDevice';
import { DeleteTr069Device } from '@application/use-cases/DeleteTr069Device';

export function createTr069Router(
  listTr069Profiles: ListTr069Profiles,
  createTr069Profile: CreateTr069Profile,
  updateTr069Profile: UpdateTr069Profile,
  deleteTr069Profile: DeleteTr069Profile,
  listTr069Devices: ListTr069Devices,
  provisionDevice: ProvisionDevice,
  deleteTr069Device: DeleteTr069Device,
): Router {
  const router = Router();

  router.get('/profiles', async (_req: Request, res: Response): Promise<void> => {
    const profiles = await listTr069Profiles.execute();
    res.json(profiles);
  });

  router.post('/profiles', async (req: Request, res: Response): Promise<void> => {
    const profile = await createTr069Profile.execute(req.body);
    res.status(201).json(profile);
  });

  router.put('/profiles/:id', async (req: Request, res: Response): Promise<void> => {
    const profile = await updateTr069Profile.execute(req.params['id'] as string, req.body);
    if (!profile) {
      res.status(404).json({ error: 'TR-069 profile not found', code: 'TR069_PROFILE_NOT_FOUND' });
      return;
    }
    res.json(profile);
  });

  router.delete('/profiles/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteTr069Profile.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'TR-069 profile not found', code: 'TR069_PROFILE_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  router.get('/devices', async (_req: Request, res: Response): Promise<void> => {
    const devices = await listTr069Devices.execute();
    res.json(devices);
  });

  router.post('/devices/:id/provision', async (req: Request, res: Response): Promise<void> => {
    const device = await provisionDevice.execute(req.params['id'] as string);
    if (!device) {
      res.status(404).json({ error: 'TR-069 device not found', code: 'TR069_DEVICE_NOT_FOUND' });
      return;
    }
    res.json(device);
  });

  router.delete('/devices/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteTr069Device.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'TR-069 device not found', code: 'TR069_DEVICE_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
