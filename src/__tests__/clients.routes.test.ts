import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { createClientsRouter } from '../infrastructure/http/routes/clients.routes';
import type { ListClients } from '../application/use-cases/ListClients';
import type { GetClientDetail } from '../application/use-cases/GetClientDetail';
import type { GetClientServices } from '../application/use-cases/GetClientServices';
import type { GetClientInvoices } from '../application/use-cases/GetClientInvoices';
import type { GetClientLogs } from '../application/use-cases/GetClientLogs';
import type { JwtAuthAdapter } from '../infrastructure/adapters/jwt/JwtAuthAdapter';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const listClients = {
    execute: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 25 }),
  } as unknown as ListClients;

  const getDetail = {
    execute: jest.fn().mockResolvedValue({ id: '1', name: 'Alice García', email: 'alice@test.com', phone: '111-1111', status: 'active', address: 'Calle 1', city: 'BA', country: 'AR', login: 'alice', createdAt: '2024-01-01' }),
  } as unknown as GetClientDetail;

  const getServices = {
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as GetClientServices;

  const getInvoices = {
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as GetClientInvoices;

  const getLogs = {
    execute: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 25 }),
  } as unknown as GetClientLogs;

  const authProvider = {
    getSession: jest.fn().mockResolvedValue({ id: '1', email: 'admin@test.com', role: 'admin' }),
  } as unknown as JwtAuthAdapter;

  app.use(
    '/api/clients',
    createClientsRouter(listClients, getDetail, getServices, getInvoices, getLogs, authProvider),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

function withAuth(req: request.Test) {
  return req.set('Cookie', 'auth_token=mock-token');
}

describe('POST /api/clients', () => {
  it('returns 201 with the created client', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients').send({
        firstName: 'Carlos',
        lastName: 'López',
        email: 'carlos@test.com',
        phone: '333-3333',
        address: 'Av. Corrientes 1234',
        status: 'active',
      })
    );

    expect(res.status).toBe(201);
    expect(res.body.firstName).toBe('Carlos');
    expect(res.body.lastName).toBe('López');
    expect(res.body.name).toBe('Carlos López');
    expect(res.body.email).toBe('carlos@test.com');
    expect(res.body.phone).toBe('333-3333');
    expect(res.body.status).toBe('active');
    expect(res.body.id).toBeTruthy();
    expect(res.body.createdAt).toBeTruthy();
  });

  it('returns 400 when required fields are missing', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients').send({
        firstName: 'Carlos',
        // missing lastName, email, phone
      })
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('defaults status to active when not provided', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients').send({
        firstName: 'María',
        lastName: 'González',
        email: 'maria@test.com',
        phone: '444-4444',
      })
    );

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
  });

  it('accepts inactive status', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients').send({
        firstName: 'Pedro',
        lastName: 'Sánchez',
        email: 'pedro@test.com',
        phone: '555-5555',
        status: 'inactive',
      })
    );

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('inactive');
  });

  it('optional address defaults to empty string when not provided', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients').send({
        firstName: 'Laura',
        lastName: 'Pérez',
        email: 'laura@test.com',
        phone: '666-6666',
      })
    );

    expect(res.status).toBe(201);
    expect(res.body.address).toBe('');
  });
});

describe('PATCH /api/clients/:id', () => {
  it('updates client fields and returns updated client', async () => {
    const app = buildApp();

    // First create a client to get an ID
    const createRes = await withAuth(
      request(app).post('/api/clients').send({
        firstName: 'Original',
        lastName: 'Name',
        email: 'original@test.com',
        phone: '111-1111',
      })
    );
    expect(createRes.status).toBe(201);
    const clientId = createRes.body.id;

    // Now patch it
    const patchRes = await withAuth(
      request(app).patch(`/api/clients/${clientId}`).send({
        firstName: 'Updated',
        email: 'updated@test.com',
      })
    );

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.firstName).toBe('Updated');
    expect(patchRes.body.email).toBe('updated@test.com');
    expect(patchRes.body.lastName).toBe('Name');
  });

  it('returns 404 for non-existent client id', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/clients/999999').send({ firstName: 'Test' })
    );

    expect(res.status).toBe(404);
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).patch('/api/clients/1').send({ firstName: 'Test' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/clients/:id/documents', () => {
  it('returns seeded documents for client 1', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).get('/api/clients/1/documents'));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body[0].name).toBe('Contrato.pdf');
    expect(res.body[1].name).toBe('DNI.jpg');
  });

  it('returns empty array for client with no documents', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).get('/api/clients/9999/documents'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/clients/1/documents');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/clients/:id/documents', () => {
  it('creates a document and returns 201', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients/2/documents').send({ name: 'Factura.pdf', size: 51200 })
    );

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Factura.pdf');
    expect(res.body.size).toBe(51200);
    expect(res.body.id).toBeTruthy();
    expect(res.body.uploadedAt).toBeTruthy();
    expect(res.body.url).toBeTruthy();
  });

  it('returns 400 when name is missing', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients/2/documents').send({ size: 1024 })
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when size is missing', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients/2/documents').send({ name: 'test.pdf' })
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/clients/2/documents').send({ name: 'test.pdf', size: 1024 });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/clients/:id/services', () => {
  it('returns 201 with created service', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients/1/services').send({ type: 'internet', plan: 'Plan 50Mbps', ipAddress: '10.0.0.1', status: 'active' })
    );

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('internet');
    expect(res.body.plan).toBe('Plan 50Mbps');
    expect(res.body.ipAddress).toBe('10.0.0.1');
    expect(res.body.id).toBeTruthy();
  });

  it('returns 400 when type is missing', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients/1/services').send({ plan: 'Plan 50Mbps' })
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when plan is missing', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients/1/services').send({ type: 'internet' })
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/clients/1/services').send({ type: 'internet', plan: 'Plan A' });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/clients/:id/services/:serviceId', () => {
  it('updates a service and returns updated data', async () => {
    const app = buildApp();

    // Create service first
    const createRes = await withAuth(
      request(app).post('/api/clients/1/services').send({ type: 'voz', plan: 'Plan Voz Básico' })
    );
    expect(createRes.status).toBe(201);
    const serviceId = createRes.body.id;

    const patchRes = await withAuth(
      request(app).patch(`/api/clients/1/services/${serviceId}`).send({ plan: 'Plan Voz Premium', status: 'suspended' })
    );

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.plan).toBe('Plan Voz Premium');
    expect(patchRes.body.status).toBe('suspended');
  });

  it('returns 404 for non-existent service', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/clients/1/services/99999').send({ plan: 'Updated' })
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SERVICE_NOT_FOUND');
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).patch('/api/clients/1/services/1').send({ plan: 'Updated' });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/clients/:id/services/:serviceId', () => {
  it('deletes a service and returns 204', async () => {
    const app = buildApp();

    // Create service first
    const createRes = await withAuth(
      request(app).post('/api/clients/2/services').send({ type: 'tv', plan: 'Plan TV HD' })
    );
    expect(createRes.status).toBe(201);
    const serviceId = createRes.body.id;

    const deleteRes = await withAuth(
      request(app).delete(`/api/clients/2/services/${serviceId}`)
    );

    expect(deleteRes.status).toBe(204);
  });

  it('returns 404 for non-existent service', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).delete('/api/clients/1/services/99999')
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SERVICE_NOT_FOUND');
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/clients/1/services/1');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/clients/:id/files', () => {
  it('returns seeded files for client 1', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).get('/api/clients/1/files'));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body[0].name).toBe('foto_antena.jpg');
    expect(res.body[1].name).toBe('mapa_ubicacion.png');
  });

  it('returns empty array for client with no files', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).get('/api/clients/9999/files'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/clients/1/files');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/clients/:id/files', () => {
  it('creates a file and returns 201', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients/3/files').send({ name: 'foto_instalacion.jpg', size: 307200 })
    );

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('foto_instalacion.jpg');
    expect(res.body.size).toBe(307200);
    expect(res.body.id).toBeTruthy();
    expect(res.body.uploadedAt).toBeTruthy();
  });

  it('returns 400 when name is missing', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients/3/files').send({ size: 1024 })
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when size is missing', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/clients/3/files').send({ name: 'test.jpg' })
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/clients/3/files').send({ name: 'test.jpg', size: 1024 });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/clients/online', () => {
  it('returns array of online sessions', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).get('/api/clients/online'));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toHaveProperty('clientName');
    expect(res.body[0]).toHaveProperty('ip');
    expect(res.body[0]).toHaveProperty('mac');
    expect(res.body[0]).toHaveProperty('downloadMbps');
    expect(res.body[0]).toHaveProperty('uploadMbps');
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/clients/online');
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/clients/online/:sessionId', () => {
  it('deletes an existing session and returns 204', async () => {
    const app = buildApp();

    // Get current sessions first
    const listRes = await withAuth(request(app).get('/api/clients/online'));
    expect(listRes.status).toBe(200);
    const sessionId = listRes.body[0].id;

    const deleteRes = await withAuth(request(app).delete(`/api/clients/online/${sessionId}`));
    expect(deleteRes.status).toBe(204);
  });

  it('returns 404 for non-existent session', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).delete('/api/clients/online/999999'));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Session not found');
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/clients/online/1');
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/clients/:id', () => {
  it('returns 204 for a newly created client', async () => {
    const app = buildApp();

    const createRes = await withAuth(
      request(app).post('/api/clients').send({
        firstName: 'ToDelete',
        lastName: 'User',
        email: 'todelete@test.com',
        phone: '999-9999',
      })
    );
    expect(createRes.status).toBe(201);
    const clientId = createRes.body.id;

    const deleteRes = await withAuth(request(app).delete(`/api/clients/${clientId}`));
    expect(deleteRes.status).toBe(204);
  });

  it('returns 404 for unknown client id', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).delete('/api/clients/999999'));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CLIENT_NOT_FOUND');
  });

  it('GET /:id after DELETE returns 404', async () => {
    const app = buildApp();

    const createRes = await withAuth(
      request(app).post('/api/clients').send({
        firstName: 'DeleteThenGet',
        lastName: 'Test',
        email: 'dtg@test.com',
        phone: '888-8888',
      })
    );
    expect(createRes.status).toBe(201);
    const clientId = createRes.body.id;

    await withAuth(request(app).delete(`/api/clients/${clientId}`));

    // After delete, GET should return 404 — but getDetail mock always resolves so we check deletedClientsStore
    // The route checks deletedClientsStore before calling getDetail, so the 404 is returned
    const getRes = await withAuth(request(app).get(`/api/clients/${clientId}`));
    expect(getRes.status).toBe(404);
  });
});

describe('PATCH /api/clients/:id/status', () => {
  it('updates client status and returns updated client', async () => {
    const app = buildApp();

    // Create a client first
    const createRes = await withAuth(
      request(app).post('/api/clients').send({
        firstName: 'StatusTest',
        lastName: 'User',
        email: 'status@test.com',
        phone: '777-7777',
        status: 'active',
      })
    );
    expect(createRes.status).toBe(201);
    const clientId = createRes.body.id;

    // Toggle to blocked
    const patchRes = await withAuth(
      request(app).patch(`/api/clients/${clientId}/status`).send({ status: 'blocked' })
    );

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe('blocked');
  });

  it('returns 404 for non-existent client id', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/clients/999999/status').send({ status: 'active' })
    );

    expect(res.status).toBe(404);
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).patch('/api/clients/1/status').send({ status: 'active' });
    expect(res.status).toBe(401);
  });
});
