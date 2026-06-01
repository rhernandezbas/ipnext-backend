/**
 * TDD — POST /api/tickets/:id/tasks (tickets-actions-be)
 *
 * AD-7: Route mounted before /:id to avoid capture.
 * AD-2: contractId is REQUIRED in the body.
 * AD-1: ticketId comes from the path param — NOT body-overridable.
 * AD-8: stageId default resolves via stageRepo.getDefaultWorkflowStageByLegacyStatus('pending').
 */

import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryTicketRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryEntityLookup } from '../../infrastructure/adapters/in-memory/InMemoryEntityLookup';
import { ListTickets } from '../../application/use-cases/ListTickets';
import { GetTicketStats } from '../../application/use-cases/GetTicketStats';
import { CreateTicket } from '../../application/use-cases/CreateTicket';
import { GetTicket } from '../../application/use-cases/GetTicket';
import { UpdateTicketStatus } from '../../application/use-cases/UpdateTicketStatus';
import { UpdateTicket } from '../../application/use-cases/UpdateTicket';
import { CloseTicket } from '../../application/use-cases/CloseTicket';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { CreateTaskFromTicket } from '../../application/use-cases/CreateTaskFromTicket';
import { createTicketsRouter } from '../../infrastructure/http/routes/tickets.routes';
import { Stage } from '../../domain/entities/workflow';
import type { JwtAuthAdapter } from '../../infrastructure/adapters/jwt/JwtAuthAdapter';

const DEFAULT_STAGE_ID = '10000000-0000-4000-a000-000000000001';

const CUSTOMER_ID = 'cust-abc';
const CONTRACT_ID = 'cont-xyz';
const TICKET_ID = 'ticket-test-1';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // Ticket repo — seed a ticket
  const ticketRepo = new InMemoryTicketRepository();
  ticketRepo.seedCustomers([{ id: CUSTOMER_ID, name: 'Test Customer' }]);

  // Seed scheduling task repo
  const taskRepo = new InMemorySchedulingRepository();
  taskRepo.seedTicketSubject(TICKET_ID, 'Internet down since Monday');

  // Stage repo
  const stageRepo = new InMemoryStageRepository();
  const defaultStage: Stage = {
    id: DEFAULT_STAGE_ID,
    workflowId: 'wf-default',
    name: 'Nuevo',
    category: 'nuevo',
    order: 0,
    color: null,
  };
  stageRepo.addDirect(defaultStage);

  // Entity lookups
  const customerLookup = new InMemoryEntityLookup([{ id: CUSTOMER_ID }]);
  const contractLookup = new InMemoryEntityLookup([{ id: CONTRACT_ID }]);
  const emptyLookup = new InMemoryEntityLookup([]);
  const adminLookup = new InMemoryEntityLookup([{ id: 'admin-1' }]);
  const ticketLookup = new InMemoryEntityLookup([{ id: TICKET_ID }]);

  const createTask = new CreateTask(
    taskRepo,
    customerLookup,
    contractLookup,
    emptyLookup,
    adminLookup,
    emptyLookup,
    ticketLookup,
  );

  const createTaskFromTicket = new CreateTaskFromTicket(createTask, taskRepo);

  const listTickets = new ListTickets(ticketRepo);
  const getStats = new GetTicketStats(ticketRepo);
  const createTicketUc = new CreateTicket(ticketRepo);
  const getTicket = new GetTicket(ticketRepo);
  const updateStatus = new UpdateTicketStatus(ticketRepo);
  const updateTicket = new UpdateTicket(ticketRepo);
  const closeTicket = new CloseTicket(ticketRepo);

  const authProvider = {
    getSession: jest.fn().mockResolvedValue({ id: 'admin-1', email: 'admin@test.com', role: 'admin' }),
  } as unknown as JwtAuthAdapter;

  app.use(
    '/api/tickets',
    createTicketsRouter(
      listTickets,
      getStats,
      createTicketUc,
      getTicket,
      updateStatus,
      updateTicket,
      closeTicket,
      authProvider,
      createTaskFromTicket,
      taskRepo,
      stageRepo,
    ),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, taskRepo, ticketRepo };
}

function withAuth(req: request.Test) {
  return req.set('Cookie', 'auth_token=mock-token');
}

describe('POST /api/tickets/:id/tasks', () => {
  it('creates a task linked to the ticket (201)', async () => {
    const { app } = buildApp();

    const res = await withAuth(
      request(app).post(`/api/tickets/${TICKET_ID}/tasks`).send({
        contractId: CONTRACT_ID,
        customerId: CUSTOMER_ID,
        title: 'Internet down since Monday',
        description: 'Fix internet for client',
        priority: 'high',
        estimatedHours: 2,
        category: 'support',
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body.ticketId).toBe(TICKET_ID);
    expect(res.body.ticketSubject).toBe('Internet down since Monday');
    expect(res.body.contractId).toBe(CONTRACT_ID);
    expect(res.body.customerId).toBe(CUSTOMER_ID);
  });

  it('returns 400 when contractId is missing', async () => {
    const { app } = buildApp();

    const res = await withAuth(
      request(app).post(`/api/tickets/${TICKET_ID}/tasks`).send({
        customerId: CUSTOMER_ID,
        title: 'Missing contract',
        priority: 'normal',
        estimatedHours: 1,
        category: 'support',
      }),
    );

    expect(res.status).toBe(400);
  });

  it('returns 404 when ticket does not exist', async () => {
    const { app } = buildApp();

    const res = await withAuth(
      request(app).post('/api/tickets/nonexistent-ticket/tasks').send({
        contractId: CONTRACT_ID,
        customerId: CUSTOMER_ID,
        title: 'Test',
        priority: 'normal',
        estimatedHours: 1,
        category: 'support',
      }),
    );

    expect(res.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    const { app } = buildApp();

    const res = await request(app).post(`/api/tickets/${TICKET_ID}/tasks`).send({
      contractId: CONTRACT_ID,
      customerId: CUSTOMER_ID,
      title: 'Test',
      priority: 'normal',
      estimatedHours: 1,
      category: 'support',
    });

    expect(res.status).toBe(401);
  });

  it('ticketId from path cannot be overridden by body', async () => {
    const { app } = buildApp();

    const res = await withAuth(
      request(app).post(`/api/tickets/${TICKET_ID}/tasks`).send({
        contractId: CONTRACT_ID,
        customerId: CUSTOMER_ID,
        ticketId: 'attacker-injected-id',  // should be ignored
        title: 'Test override',
        priority: 'normal',
        estimatedHours: 1,
        category: 'support',
      }),
    );

    expect(res.status).toBe(201);
    // ticketId must be from the path, not the body
    expect(res.body.ticketId).toBe(TICKET_ID);
    expect(res.body.ticketId).not.toBe('attacker-injected-id');
  });
});
