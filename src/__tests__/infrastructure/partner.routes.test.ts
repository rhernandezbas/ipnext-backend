import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryPartnerRepository } from '../../infrastructure/adapters/in-memory/InMemoryPartnerRepository';
import { ListPartners } from '../../application/use-cases/ListPartners';
import { GetPartner } from '../../application/use-cases/GetPartner';
import { CreatePartner } from '../../application/use-cases/CreatePartner';
import { UpdatePartner } from '../../application/use-cases/UpdatePartner';
import { DeletePartner } from '../../application/use-cases/DeletePartner';
import { createPartnerRouter } from '../../infrastructure/http/routes/partner.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryPartnerRepository();
  const listPartners = new ListPartners(repo);
  const getPartner = new GetPartner(repo);
  const createPartner = new CreatePartner(repo);
  const updatePartner = new UpdatePartner(repo);
  const deletePartner = new DeletePartner(repo);

  app.use('/api/partners', createPartnerRouter(listPartners, getPartner, createPartner, updatePartner, deletePartner));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/partners', () => {
  it('returns 200 with array of partners', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/partners');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
  });
});

describe('POST /api/partners', () => {
  it('returns 201 with new partner', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/partners')
      .send({
        name: 'IPNEXT Mendoza',
        status: 'active',
        primaryEmail: 'mza@ipnext.com.ar',
        phone: '+54261000000',
        address: 'Av. San Martín 500',
        city: 'Mendoza',
        country: 'AR',
        timezone: 'America/Argentina/Mendoza',
        currency: 'ARS',
        logoUrl: null,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('IPNEXT Mendoza');
  });
});

describe('DELETE /api/partners/:id', () => {
  it('returns 204 on successful delete', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/partners/3');

    expect(res.status).toBe(204);
  });
});
