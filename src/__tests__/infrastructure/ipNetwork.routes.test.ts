import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryIpNetworkRepository } from '../../infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { ListIpNetworks } from '../../application/use-cases/ListIpNetworks';
import { CreateIpNetwork } from '../../application/use-cases/CreateIpNetwork';
import { DeleteIpNetwork } from '../../application/use-cases/DeleteIpNetwork';
import { ListIpPools } from '../../application/use-cases/ListIpPools';
import { CreateIpPool } from '../../application/use-cases/CreateIpPool';
import { ListIpAssignments } from '../../application/use-cases/ListIpAssignments';
import { createIpNetworkRouter } from '../../infrastructure/http/routes/ipNetwork.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryIpNetworkRepository();

  const router = createIpNetworkRouter(
    new ListIpNetworks(repo),
    new CreateIpNetwork(repo),
    new DeleteIpNetwork(repo),
    new ListIpPools(repo),
    new CreateIpPool(repo),
    new ListIpAssignments(repo),
  );
  app.use('/api', router);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/ip-networks', () => {
  it('returns 200 with array of 2 networks', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/ip-networks');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });
});

describe('GET /api/ip-pools', () => {
  it('returns 200 with array of 3 pools', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/ip-pools');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
  });
});
