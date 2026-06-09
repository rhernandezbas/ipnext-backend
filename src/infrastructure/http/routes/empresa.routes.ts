import { Router, Request, Response } from 'express';
import { ListServicePlans } from '@application/use-cases/ListServicePlans';
import { GetServicePlan } from '@application/use-cases/GetServicePlan';
import { CreateServicePlan } from '@application/use-cases/CreateServicePlan';
import { UpdateServicePlan } from '@application/use-cases/UpdateServicePlan';
import { DeleteServicePlan } from '@application/use-cases/DeleteServicePlan';
import { ListNetworkDevices } from '@application/use-cases/ListNetworkDevices';
import { GetNetworkDevice } from '@application/use-cases/GetNetworkDevice';
import { CreateNetworkDevice } from '@application/use-cases/CreateNetworkDevice';
import { UpdateNetworkDevice } from '@application/use-cases/UpdateNetworkDevice';
import { DeleteNetworkDevice } from '@application/use-cases/DeleteNetworkDevice';

/**
 * Empresa router — ServicePlans + NetworkDevices.
 * World A Inventory routes removed in Wave 7 (Capstone).
 */
export function createEmpresaRouter(
  listServicePlans: ListServicePlans,
  getServicePlan: GetServicePlan,
  createServicePlan: CreateServicePlan,
  updateServicePlan: UpdateServicePlan,
  deleteServicePlan: DeleteServicePlan,
  listNetworkDevices: ListNetworkDevices,
  getNetworkDevice: GetNetworkDevice,
  createNetworkDevice: CreateNetworkDevice,
  updateNetworkDevice: UpdateNetworkDevice,
  deleteNetworkDevice: DeleteNetworkDevice,
): Router {
  const router = Router();

  // Service Plans
  router.get('/service-plans', async (req: Request, res: Response): Promise<void> => {
    const { subtype } = req.query as Record<string, string>;
    const plans = await listServicePlans.execute(subtype || undefined);
    res.json(plans);
  });

  router.post('/service-plans', async (req: Request, res: Response): Promise<void> => {
    const plan = await createServicePlan.execute(req.body);
    res.status(201).json(plan);
  });

  router.get('/service-plans/:id', async (req: Request, res: Response): Promise<void> => {
    const plan = await getServicePlan.execute(req.params['id'] as string);
    if (!plan) {
      res.status(404).json({ error: 'Service plan not found', code: 'SERVICE_PLAN_NOT_FOUND' });
      return;
    }
    res.json(plan);
  });

  router.put('/service-plans/:id', async (req: Request, res: Response): Promise<void> => {
    const plan = await updateServicePlan.execute(req.params['id'] as string, req.body);
    if (!plan) {
      res.status(404).json({ error: 'Service plan not found', code: 'SERVICE_PLAN_NOT_FOUND' });
      return;
    }
    res.json(plan);
  });

  router.delete('/service-plans/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteServicePlan.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Service plan not found', code: 'SERVICE_PLAN_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  // Network Devices
  router.get('/network-devices', async (_req: Request, res: Response): Promise<void> => {
    const devices = await listNetworkDevices.execute();
    res.json(devices);
  });

  router.post('/network-devices', async (req: Request, res: Response): Promise<void> => {
    const device = await createNetworkDevice.execute(req.body);
    res.status(201).json(device);
  });

  router.get('/network-devices/:id', async (req: Request, res: Response): Promise<void> => {
    const device = await getNetworkDevice.execute(req.params['id'] as string);
    if (!device) {
      res.status(404).json({ error: 'Network device not found', code: 'NETWORK_DEVICE_NOT_FOUND' });
      return;
    }
    res.json(device);
  });

  router.put('/network-devices/:id', async (req: Request, res: Response): Promise<void> => {
    const device = await updateNetworkDevice.execute(req.params['id'] as string, req.body);
    if (!device) {
      res.status(404).json({ error: 'Network device not found', code: 'NETWORK_DEVICE_NOT_FOUND' });
      return;
    }
    res.json(device);
  });

  router.delete('/network-devices/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteNetworkDevice.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Network device not found', code: 'NETWORK_DEVICE_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
