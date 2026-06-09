/**
 * SCEN-VH-1..8 — Vehicle CRUD route integration tests (EPIC #38, Wave 5b).
 * Uses in-memory repos + supertest. No Prisma, no DB.
 *
 * TDD: written alongside implementation to drive correctness.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { createVehicleRouter } from '@infrastructure/http/routes/vehicle.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryVehicleRepository } from '@infrastructure/adapters/in-memory/InMemoryVehicleRepository';
import { ListVehicles } from '@application/use-cases/ListVehicles';
import { GetVehicle } from '@application/use-cases/GetVehicle';
import { CreateVehicle } from '@application/use-cases/CreateVehicle';
import { UpdateVehicle } from '@application/use-cases/UpdateVehicle';
import { DeleteVehicle } from '@application/use-cases/DeleteVehicle';

// ─── Minimal auth middleware (no-op — sets req.user) ─────────────────────────

const noopAuth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  (req as { user?: { id: string } }).user = { id: 'u1' };
  next();
};

// ─── App builder ──────────────────────────────────────────────────────────────

interface Perms {
  read?: boolean;
  manage?: boolean;
}

function makeGuard(allowed: boolean): RequestHandler {
  return allowed
    ? (_r: Request, _s: Response, n: NextFunction) => n()
    : (_r: Request, s: Response) => s.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
}

async function buildApp(perms: Perms = { read: true, manage: true }) {
  const repo = new InMemoryVehicleRepository();

  const router = createVehicleRouter(
    new ListVehicles(repo),
    new GetVehicle(repo),
    new CreateVehicle(repo),
    new UpdateVehicle(repo),
    new DeleteVehicle(repo),
    noopAuth,
    makeGuard(perms.read !== false),
    makeGuard(perms.manage !== false),
  );

  const app = express();
  app.use(express.json());
  app.use('/api/vehicles', router);
  app.use(errorHandler);
  return { app, repo };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('vehicles routes', () => {
  // SCEN-VH-1: create vehicle happy path → 201
  it('SCEN-VH-1: POST /api/vehicles creates a vehicle and returns 201', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/vehicles').send({ plate: 'ABC-123', name: 'Camioneta Norte' });
    expect(res.status).toBe(201);
    expect(res.body.plate).toBe('ABC-123');
    expect(res.body.status).toBe('active');
    expect(res.body.id).toBeDefined();
  });

  // SCEN-VH-2: duplicate plate → 409 VEHICLE_PLATE_CONFLICT
  it('SCEN-VH-2: POST duplicate plate returns 409 VEHICLE_PLATE_CONFLICT', async () => {
    const { app } = await buildApp();
    await request(app).post('/api/vehicles').send({ plate: 'ABC-123' });
    const res = await request(app).post('/api/vehicles').send({ plate: 'ABC-123' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VEHICLE_PLATE_CONFLICT');
  });

  // SCEN-VH-3: missing plate → 400
  it('SCEN-VH-3: POST without plate returns 400', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/vehicles').send({});
    expect(res.status).toBe(400);
  });

  // SCEN-VH-4: toggle status → 200 with updated status
  it('SCEN-VH-4: PATCH /:id toggles status to inactive', async () => {
    const { app } = await buildApp();
    const createRes = await request(app).post('/api/vehicles').send({ plate: 'DEF-456' });
    const id = createRes.body.id;
    const res = await request(app).patch(`/api/vehicles/${id}`).send({ status: 'inactive' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('inactive');
  });

  // SCEN-VH-5: guarded delete — vehicle has CAMIONETA location → 409 VEHICLE_IN_USE
  it('SCEN-VH-5: DELETE with refs returns 409 VEHICLE_IN_USE', async () => {
    const { app, repo } = await buildApp();
    const createRes = await request(app).post('/api/vehicles').send({ plate: 'GHI-789' });
    const id = createRes.body.id;
    repo.setLocationRefCount(id, 1);
    const res = await request(app).delete(`/api/vehicles/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VEHICLE_IN_USE');
  });

  // SCEN-VH-6: safe delete — no references → 204
  it('SCEN-VH-6: DELETE with no refs returns 204', async () => {
    const { app } = await buildApp();
    const createRes = await request(app).post('/api/vehicles').send({ plate: 'JKL-012' });
    const id = createRes.body.id;
    const res = await request(app).delete(`/api/vehicles/${id}`);
    expect(res.status).toBe(204);
  });

  // SCEN-VH-7: list requires inventory.read → 403 when missing
  it('SCEN-VH-7: GET /api/vehicles returns 403 without inventory.read', async () => {
    const { app } = await buildApp({ read: false, manage: true });
    const res = await request(app).get('/api/vehicles');
    expect(res.status).toBe(403);
  });

  // SCEN-VH-8: create requires inventory.manage → 403 when only read
  it('SCEN-VH-8: POST /api/vehicles returns 403 with only inventory.read', async () => {
    const { app } = await buildApp({ read: true, manage: false });
    const res = await request(app).post('/api/vehicles').send({ plate: 'MNO-345' });
    expect(res.status).toBe(403);
  });

  // FF-2: Prisma P2002 race on plate unique index → 409 VEHICLE_PLATE_CONFLICT (not 500)
  it('FF-2: POST /api/vehicles with P2002 from repo → 409 VEHICLE_PLATE_CONFLICT', async () => {
    const repo = new InMemoryVehicleRepository();
    // Make create throw a raw P2002-shaped error (simulates DB unique constraint race)
    jest.spyOn(repo, 'create').mockRejectedValueOnce({ code: 'P2002' });

    const router = createVehicleRouter(
      new ListVehicles(repo),
      new GetVehicle(repo),
      new CreateVehicle(repo),
      new UpdateVehicle(repo),
      new DeleteVehicle(repo),
      noopAuth,
      makeGuard(true),
      makeGuard(true),
    );

    const app = express();
    app.use(express.json());
    app.use('/api/vehicles', router);
    app.use(errorHandler);

    const res = await request(app).post('/api/vehicles').send({ plate: 'RACE-1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VEHICLE_PLATE_CONFLICT');
  });
});
