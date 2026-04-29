import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryLeadRepository } from '../../infrastructure/adapters/in-memory/InMemoryLeadRepository';
import { ListLeads } from '../../application/use-cases/ListLeads';
import { GetLead } from '../../application/use-cases/GetLead';
import { CreateLead } from '../../application/use-cases/CreateLead';
import { UpdateLead } from '../../application/use-cases/UpdateLead';
import { DeleteLead } from '../../application/use-cases/DeleteLead';
import { ConvertLeadToClient } from '../../application/use-cases/ConvertLeadToClient';
import { createLeadsRouter } from '../../infrastructure/http/routes/leads.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  const repo = new InMemoryLeadRepository();
  const listLeads = new ListLeads(repo);
  const getLead = new GetLead(repo);
  const createLead = new CreateLead(repo);
  const updateLead = new UpdateLead(repo);
  const deleteLead = new DeleteLead(repo);
  const convertLeadToClient = new ConvertLeadToClient(repo);
  app.use('/api/leads', createLeadsRouter(listLeads, getLead, createLead, updateLead, deleteLead, convertLeadToClient));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

describe('ListLeads', () => {
  it('returns 8 leads', async () => {
    const repo = new InMemoryLeadRepository();
    const uc = new ListLeads(repo);
    const result = await uc.execute();
    expect(result).toHaveLength(8);
  });
});

describe('GetLead', () => {
  it('returns lead by id', async () => {
    const repo = new InMemoryLeadRepository();
    const uc = new GetLead(repo);
    const result = await uc.execute('1');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Federico Álvarez');
  });
});

describe('CreateLead', () => {
  it('creates lead with status new', async () => {
    const repo = new InMemoryLeadRepository();
    const uc = new CreateLead(repo);
    const result = await uc.execute({
      name: 'Test Lead',
      email: 'test@test.com',
      phone: '11-1234-5678',
      address: 'Test St 123',
      city: 'Buenos Aires',
      source: 'website',
      status: 'new',
      assignedTo: 'Admin',
      assignedToId: 'admin-1',
      interestedIn: 'Plan Estándar 100Mbps',
      notes: '',
      followUpDate: null,
    });
    expect(result.status).toBe('new');
    expect(result.id).toBeTruthy();
  });
});

describe('UpdateLead', () => {
  it('updates status to contacted', async () => {
    const repo = new InMemoryLeadRepository();
    const uc = new UpdateLead(repo);
    const result = await uc.execute('1', { status: 'contacted' });
    expect(result).not.toBeNull();
    expect(result!.status).toBe('contacted');
  });
});

describe('GET /api/leads', () => {
  it('returns 200', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/leads');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /api/leads', () => {
  it('returns 201', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/leads')
      .send({
        name: 'Nuevo Lead',
        email: 'nuevo@lead.com',
        phone: '11-9988-7766',
        address: 'Av. Test 100',
        city: 'Buenos Aires',
        source: 'website',
        status: 'new',
        assignedTo: 'María López',
        assignedToId: 'admin-1',
        interestedIn: 'Plan Estándar 100Mbps',
        notes: 'Test notes',
        followUpDate: null,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe('new');
  });
});
