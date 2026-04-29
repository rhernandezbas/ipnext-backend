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
import { ListInventoryProducts } from '../../application/use-cases/ListInventoryProducts';
import { ListInventoryUnits } from '../../application/use-cases/ListInventoryUnits';
import { CreateInventoryUnit } from '../../application/use-cases/CreateInventoryUnit';
import { UpdateInventoryUnit } from '../../application/use-cases/UpdateInventoryUnit';
import { createEmpresaRouter } from '../../infrastructure/http/routes/empresa.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryEmpresaRepository();

  app.use('/api', createEmpresaRouter(
    new ListServicePlans(repo),
    new GetServicePlan(repo),
    new CreateServicePlan(repo),
    new UpdateServicePlan(repo),
    new DeleteServicePlan(repo),
    new ListNetworkDevices(repo),
    new GetNetworkDevice(repo),
    new CreateNetworkDevice(repo),
    new UpdateNetworkDevice(repo),
    new DeleteNetworkDevice(repo),
    new ListInventoryItems(repo),
    new GetInventoryItem(repo),
    new CreateInventoryItem(repo),
    new UpdateInventoryItem(repo),
    new DeleteInventoryItem(repo),
    new ListInventoryProducts(repo),
    new ListInventoryUnits(repo),
    new CreateInventoryUnit(repo),
    new UpdateInventoryUnit(repo),
  ));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/inventory/items', () => {
  it('returns 200 with array of 10 units', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/inventory/items');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(10);
  });
});

describe('GET /api/inventory/products', () => {
  it('returns 200 with array of 5 products', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/inventory/products');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(5);
  });
});
