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
import { ListInventoryItems } from '@application/use-cases/ListInventoryItems';
import { GetInventoryItem } from '@application/use-cases/GetInventoryItem';
import { CreateInventoryItem } from '@application/use-cases/CreateInventoryItem';
import { UpdateInventoryItem } from '@application/use-cases/UpdateInventoryItem';
import { DeleteInventoryItem } from '@application/use-cases/DeleteInventoryItem';
import { ListInventoryProducts } from '@application/use-cases/ListInventoryProducts';
import { UpdateInventoryProduct } from '@application/use-cases/UpdateInventoryProduct';
import { DeleteInventoryProduct } from '@application/use-cases/DeleteInventoryProduct';
import { ListInventoryUnits } from '@application/use-cases/ListInventoryUnits';
import { CreateInventoryUnit } from '@application/use-cases/CreateInventoryUnit';
import { UpdateInventoryUnit } from '@application/use-cases/UpdateInventoryUnit';
import { DeleteInventoryUnit } from '@application/use-cases/DeleteInventoryUnit';

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
  listInventoryItems: ListInventoryItems,
  getInventoryItem: GetInventoryItem,
  createInventoryItem: CreateInventoryItem,
  updateInventoryItem: UpdateInventoryItem,
  deleteInventoryItem: DeleteInventoryItem,
  listInventoryProducts?: ListInventoryProducts,
  listInventoryUnits?: ListInventoryUnits,
  createInventoryUnit?: CreateInventoryUnit,
  updateInventoryUnit?: UpdateInventoryUnit,
  updateInventoryProduct?: UpdateInventoryProduct,
  deleteInventoryProduct?: DeleteInventoryProduct,
  deleteInventoryUnit?: DeleteInventoryUnit,
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

  // Inventory — NOTE: specific sub-paths MUST come before /:id to avoid route conflicts
  router.get('/inventory', async (_req: Request, res: Response): Promise<void> => {
    const items = await listInventoryItems.execute();
    res.json(items);
  });

  router.post('/inventory', async (req: Request, res: Response): Promise<void> => {
    const item = await createInventoryItem.execute(req.body);
    res.status(201).json(item);
  });

  // Inventory Products (catalog) — before /:id
  router.get('/inventory/products', async (_req: Request, res: Response): Promise<void> => {
    if (!listInventoryProducts) { res.status(501).json({ error: 'Not implemented' }); return; }
    const products = await listInventoryProducts.execute();
    res.json(products);
  });

  router.put('/inventory/products/:id', async (req: Request, res: Response): Promise<void> => {
    if (!updateInventoryProduct) { res.status(501).json({ error: 'Not implemented' }); return; }
    const product = await updateInventoryProduct.execute(req.params['id'] as string, req.body);
    if (!product) {
      res.status(404).json({ error: 'Inventory product not found', code: 'INVENTORY_PRODUCT_NOT_FOUND' });
      return;
    }
    res.json(product);
  });

  router.delete('/inventory/products/:id', async (req: Request, res: Response): Promise<void> => {
    if (!deleteInventoryProduct) { res.status(501).json({ error: 'Not implemented' }); return; }
    const deleted = await deleteInventoryProduct.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Inventory product not found', code: 'INVENTORY_PRODUCT_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  // Inventory Units (physical units) — before /:id
  router.get('/inventory/items', async (req: Request, res: Response): Promise<void> => {
    if (!listInventoryUnits) { res.status(501).json({ error: 'Not implemented' }); return; }
    const { productId } = req.query as { productId?: string };
    const units = await listInventoryUnits.execute(productId);
    res.json(units);
  });

  router.post('/inventory/items', async (req: Request, res: Response): Promise<void> => {
    if (!createInventoryUnit) { res.status(501).json({ error: 'Not implemented' }); return; }
    const unit = await createInventoryUnit.execute(req.body);
    res.status(201).json(unit);
  });

  router.put('/inventory/items/:id', async (req: Request, res: Response): Promise<void> => {
    if (!updateInventoryUnit) { res.status(501).json({ error: 'Not implemented' }); return; }
    const unit = await updateInventoryUnit.execute(req.params['id'] as string, req.body);
    if (!unit) {
      res.status(404).json({ error: 'Inventory unit not found', code: 'INVENTORY_UNIT_NOT_FOUND' });
      return;
    }
    res.json(unit);
  });

  router.delete('/inventory/items/:id', async (req: Request, res: Response): Promise<void> => {
    if (!deleteInventoryUnit) { res.status(501).json({ error: 'Not implemented' }); return; }
    const deleted = await deleteInventoryUnit.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Inventory unit not found', code: 'INVENTORY_UNIT_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  // Legacy inventory by id (after specific routes)
  router.get('/inventory/:id', async (req: Request, res: Response): Promise<void> => {
    const item = await getInventoryItem.execute(req.params['id'] as string);
    if (!item) {
      res.status(404).json({ error: 'Inventory item not found', code: 'INVENTORY_ITEM_NOT_FOUND' });
      return;
    }
    res.json(item);
  });

  router.put('/inventory/:id', async (req: Request, res: Response): Promise<void> => {
    const item = await updateInventoryItem.execute(req.params['id'] as string, req.body);
    if (!item) {
      res.status(404).json({ error: 'Inventory item not found', code: 'INVENTORY_ITEM_NOT_FOUND' });
      return;
    }
    res.json(item);
  });

  router.delete('/inventory/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteInventoryItem.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Inventory item not found', code: 'INVENTORY_ITEM_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
