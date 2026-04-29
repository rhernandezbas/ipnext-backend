import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryNasRepository } from '../../infrastructure/adapters/in-memory/InMemoryNasRepository';
import { ListNasServers } from '../../application/use-cases/ListNasServers';
import { GetNasServer } from '../../application/use-cases/GetNasServer';
import { CreateNasServer } from '../../application/use-cases/CreateNasServer';
import { UpdateNasServer } from '../../application/use-cases/UpdateNasServer';
import { DeleteNasServer } from '../../application/use-cases/DeleteNasServer';
import { GetRadiusConfig } from '../../application/use-cases/GetRadiusConfig';
import { UpdateRadiusConfig } from '../../application/use-cases/UpdateRadiusConfig';
import { createNasRouter } from '../../infrastructure/http/routes/nas.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryNasRepository();

  const router = createNasRouter(
    new ListNasServers(repo),
    new GetNasServer(repo),
    new CreateNasServer(repo),
    new UpdateNasServer(repo),
    new DeleteNasServer(repo),
    new GetRadiusConfig(repo),
    new UpdateRadiusConfig(repo),
  );
  app.use('/api', router);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/nas-servers', () => {
  it('returns 200 with array of 3 NAS servers', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/nas-servers');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
  });
});

describe('PUT /api/radius-config', () => {
  it('returns 200 with updated config', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/radius-config')
      .send({ sessionTimeout: 7200 });

    expect(res.status).toBe(200);
    expect(res.body.sessionTimeout).toBe(7200);
    expect(res.body.authPort).toBe(1812);
  });
});
