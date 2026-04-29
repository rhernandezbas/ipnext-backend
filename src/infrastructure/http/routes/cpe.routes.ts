import { Router, Request, Response } from 'express';
import { ListCpeDevices } from '@application/use-cases/ListCpeDevices';
import { GetCpeDevice } from '@application/use-cases/GetCpeDevice';
import { CreateCpeDevice } from '@application/use-cases/CreateCpeDevice';
import { UpdateCpeDevice } from '@application/use-cases/UpdateCpeDevice';
import { DeleteCpeDevice } from '@application/use-cases/DeleteCpeDevice';
import { AssignCpeToClient } from '@application/use-cases/AssignCpeToClient';

export function createCpeRouter(
  listCpeDevices: ListCpeDevices,
  getCpeDevice: GetCpeDevice,
  createCpeDevice: CreateCpeDevice,
  updateCpeDevice: UpdateCpeDevice,
  deleteCpeDevice: DeleteCpeDevice,
  assignCpeToClient: AssignCpeToClient,
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    const devices = await listCpeDevices.execute();
    res.json(devices);
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const device = await createCpeDevice.execute(req.body);
    res.status(201).json(device);
  });

  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const device = await getCpeDevice.execute(req.params['id'] as string);
    if (!device) {
      res.status(404).json({ error: 'CPE device not found', code: 'CPE_NOT_FOUND' });
      return;
    }
    res.json(device);
  });

  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    const device = await updateCpeDevice.execute(req.params['id'] as string, req.body);
    if (!device) {
      res.status(404).json({ error: 'CPE device not found', code: 'CPE_NOT_FOUND' });
      return;
    }
    res.json(device);
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteCpeDevice.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'CPE device not found', code: 'CPE_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  router.post('/:id/assign', async (req: Request, res: Response): Promise<void> => {
    const { clientId, clientName } = req.body;
    const device = await assignCpeToClient.execute(req.params['id'] as string, clientId, clientName);
    if (!device) {
      res.status(404).json({ error: 'CPE device not found', code: 'CPE_NOT_FOUND' });
      return;
    }
    res.json(device);
  });

  return router;
}
