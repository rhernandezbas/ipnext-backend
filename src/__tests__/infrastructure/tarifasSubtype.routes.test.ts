import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryEmpresaRepository } from '../../infrastructure/adapters/in-memory/InMemoryEmpresaRepository';
import { ListServicePlans } from '../../application/use-cases/ListServicePlans';
import { GetServicePlan } from '../../application/use-cases/GetServicePlan';
import { CreateServicePlan } from '../../application/use-cases/CreateServicePlan';
import { UpdateServicePlan } from '../../application/use-cases/UpdateServicePlan';
import { DeleteServicePlan } from '../../application/use-cases/DeleteServicePlan';
import { ListNetworkDevices } from '../../application/use-cases/ListNetworkDevices';
import { GetNetworkDevice } from '../../application/use-cases/GetNetworkDevice';
import { CreateNetworkDevice } from '../../application/use-cases/CreateNetworkDevice';
import { UpdateNetworkDevice } from '../../application/use-cases/UpdateNetworkDevice';
import { DeleteNetworkDevice } from '../../application/use-cases/DeleteNetworkDevice';
import { ListInventoryItems } from '../../application/use-cases/ListInventoryItems';
import { GetInventoryItem } from '../../application/use-cases/GetInventoryItem';
import { CreateInventoryItem } from '../../application/use-cases/CreateInventoryItem';
import { UpdateInventoryItem } from '../../application/use-cases/UpdateInventoryItem';
import { DeleteInventoryItem } from '../../application/use-cases/DeleteInventoryItem';
import { createEmpresaRouter } from '../../infrastructure/http/routes/empresa.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryEmpresaRepository();
  const listServicePlans = new ListServicePlans(repo);
  const getServicePlan = new GetServicePlan(repo);
  const createServicePlan = new CreateServicePlan(repo);
  const updateServicePlan = new UpdateServicePlan(repo);
  const deleteServicePlan = new DeleteServicePlan(repo);
  const listNetworkDevices = new ListNetworkDevices(repo);
  const getNetworkDevice = new GetNetworkDevice(repo);
  const createNetworkDevice = new CreateNetworkDevice(repo);
  const updateNetworkDevice = new UpdateNetworkDevice(repo);
  const deleteNetworkDevice = new DeleteNetworkDevice(repo);
  const listInventoryItems = new ListInventoryItems(repo);
  const getInventoryItem = new GetInventoryItem(repo);
  const createInventoryItem = new CreateInventoryItem(repo);
  const updateInventoryItem = new UpdateInventoryItem(repo);
  const deleteInventoryItem = new DeleteInventoryItem(repo);

  app.use('/api', createEmpresaRouter(
    listServicePlans, getServicePlan, createServicePlan, updateServicePlan, deleteServicePlan,
    listNetworkDevices, getNetworkDevice, createNetworkDevice, updateNetworkDevice, deleteNetworkDevice,
    listInventoryItems, getInventoryItem, createInventoryItem, updateInventoryItem, deleteInventoryItem,
  ));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/service-plans?subtype=voice', () => {
  it('returns 200 with only voice plans', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/service-plans?subtype=voice');

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    res.body.forEach((p: { planSubtype: string }) => expect(p.planSubtype).toBe('voice'));
  });
});
