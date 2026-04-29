import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryGponRepository } from '../../infrastructure/adapters/in-memory/InMemoryGponRepository';
import { ListOlts } from '../../application/use-cases/ListOlts';
import { GetOlt } from '../../application/use-cases/GetOlt';
import { CreateOlt } from '../../application/use-cases/CreateOlt';
import { ListOnus } from '../../application/use-cases/ListOnus';
import { GetOnu } from '../../application/use-cases/GetOnu';
import { ListOnusByOlt } from '../../application/use-cases/ListOnusByOlt';
import { CreateOnu } from '../../application/use-cases/CreateOnu';
import { UpdateOnuStatus } from '../../application/use-cases/UpdateOnuStatus';
import { createGponRouter } from '../../infrastructure/http/routes/gpon.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryGponRepository();
  const listOlts = new ListOlts(repo);
  const getOlt = new GetOlt(repo);
  const createOlt = new CreateOlt(repo);
  const listOnus = new ListOnus(repo);
  const getOnu = new GetOnu(repo);
  const listOnusByOlt = new ListOnusByOlt(repo);
  const createOnu = new CreateOnu(repo);
  const updateOnuStatus = new UpdateOnuStatus(repo);

  app.use('/api/gpon', createGponRouter(listOlts, getOlt, listOnus, getOnu, listOnusByOlt, createOlt, createOnu, updateOnuStatus));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/gpon/olts', () => {
  it('returns 200 with OLTs array', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/gpon/olts');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });
});

describe('GET /api/gpon/onus', () => {
  it('returns 200 with all 20 ONUs', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/gpon/onus');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(20);
  });
});

describe('POST /api/gpon/olts', () => {
  it('returns 201 with new OLT', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/gpon/olts')
      .send({ name: 'OLT Nueva', ip: '10.0.2.1', model: 'MA5800-X2', location: 'Zona Sur' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('OLT Nueva');
  });
});

describe('POST /api/gpon/onus', () => {
  it('returns 201 with new ONU', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/gpon/onus')
      .send({ serial: 'HWTCAABBCCDD', model: 'HG8010H', oltId: 1, port: 3 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.serialNumber).toBe('HWTCAABBCCDD');
  });
});

describe('PATCH /api/gpon/onus/:id/status', () => {
  it('returns 200 with updated status', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/gpon/onus/onu-1/status')
      .send({ status: 'offline' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('offline');
  });

  it('returns 404 for unknown ONU', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/gpon/onus/onu-9999/status')
      .send({ status: 'offline' });

    expect(res.status).toBe(404);
  });
});
