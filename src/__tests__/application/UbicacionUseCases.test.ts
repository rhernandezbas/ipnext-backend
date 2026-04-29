import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryUbicacionRepository } from '../../infrastructure/adapters/in-memory/InMemoryUbicacionRepository';
import { ListUbicaciones } from '../../application/use-cases/ListUbicaciones';
import { GetUbicacion } from '../../application/use-cases/GetUbicacion';
import { CreateUbicacion } from '../../application/use-cases/CreateUbicacion';
import { UpdateUbicacion } from '../../application/use-cases/UpdateUbicacion';
import { DeleteUbicacion } from '../../application/use-cases/DeleteUbicacion';
import { createUbicacionesRouter } from '../../infrastructure/http/routes/ubicaciones.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  const repo = new InMemoryUbicacionRepository();
  const listUbicaciones = new ListUbicaciones(repo);
  const getUbicacion = new GetUbicacion(repo);
  const createUbicacion = new CreateUbicacion(repo);
  const updateUbicacion = new UpdateUbicacion(repo);
  const deleteUbicacion = new DeleteUbicacion(repo);
  app.use('/api/locations', createUbicacionesRouter(listUbicaciones, getUbicacion, createUbicacion, updateUbicacion, deleteUbicacion));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

describe('ListUbicaciones', () => {
  it('returns 6 locations', async () => {
    const repo = new InMemoryUbicacionRepository();
    const uc = new ListUbicaciones(repo);
    const result = await uc.execute();
    expect(result).toHaveLength(6);
  });
});

describe('GetUbicacion', () => {
  it('returns location by id', async () => {
    const repo = new InMemoryUbicacionRepository();
    const uc = new GetUbicacion(repo);
    const result = await uc.execute('1');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Main');
  });
});

describe('CreateUbicacion', () => {
  it('creates a new location', async () => {
    const repo = new InMemoryUbicacionRepository();
    const uc = new CreateUbicacion(repo);
    const result = await uc.execute({
      name: 'Nueva Sucursal',
      address: 'Av. Test 1000',
      city: 'Mendoza',
      state: 'Mendoza',
      country: 'Argentina',
      phone: '+54 261 400-0001',
      email: 'mendoza@ipnext.com.ar',
      manager: 'Test Admin',
      clientCount: 0,
      status: 'active',
      coordinates: null,
      timezone: 'America/Argentina/Mendoza',
    });
    expect(result.id).toBeTruthy();
    expect(result.name).toBe('Nueva Sucursal');
  });
});

describe('GET /api/locations', () => {
  it('returns 200', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/locations');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /api/locations', () => {
  it('returns 201', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/locations')
      .send({
        name: 'Nueva Sucursal',
        address: 'Test 100',
        city: 'Mendoza',
        state: 'Mendoza',
        country: 'Argentina',
        phone: '+54 261 400-0001',
        email: 'mendoza@ipnext.com.ar',
        manager: 'Test Admin',
        clientCount: 0,
        status: 'active',
        coordinates: null,
        timezone: 'America/Argentina/Mendoza',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
  });
});
