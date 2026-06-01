/**
 * TDD — CreateTaskFromTicket (tickets-actions-be)
 *
 * AD-1: CreateTaskFromTicket delegates to CreateTask (not repo directly).
 * AD-2: contractId REQUIRED in the input (FE picks from client contracts).
 * AD-3: ticketId FK validated by CreateTask via optional ticketLookup.
 * AD-7: ticketId comes from input, NOT body-overridable by the route.
 */

import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryEntityLookup } from '../../infrastructure/adapters/in-memory/InMemoryEntityLookup';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { CreateTaskFromTicket } from '../../application/use-cases/CreateTaskFromTicket';
import { ReferenceNotFoundError } from '../../domain/errors/scheduling';

const STAGE_ID = '10000000-0000-4000-a000-000000000001';
const CUSTOMER_ID = 'cust-1';
const CONTRACT_ID = 'cont-1';
const TICKET_ID = 'ticket-1';
const ASSIGNEE_ID = 'admin-1';

function makeSetup() {
  const repo = new InMemorySchedulingRepository();
  const customerLookup = new InMemoryEntityLookup([{ id: CUSTOMER_ID }]);
  const contractLookup = new InMemoryEntityLookup([{ id: CONTRACT_ID }]);
  const partnerLookup = new InMemoryEntityLookup([]);
  const adminLookup = new InMemoryEntityLookup([{ id: ASSIGNEE_ID }]);
  const projectLookup = new InMemoryEntityLookup([]);
  const ticketLookup = new InMemoryEntityLookup([{ id: TICKET_ID }]);

  // Seed ticket subject so the repo can resolve it
  repo.seedTicketSubject(TICKET_ID, 'Internet down since Monday');

  const createTask = new CreateTask(
    repo,
    customerLookup,
    contractLookup,
    partnerLookup,
    adminLookup,
    projectLookup,
    ticketLookup,
  );

  const createTaskFromTicket = new CreateTaskFromTicket(createTask, repo);

  return { repo, createTask, createTaskFromTicket };
}

describe('CreateTaskFromTicket', () => {
  it('creates a task linked to the ticket with prefilled fields', async () => {
    const { createTaskFromTicket, repo } = makeSetup();

    // Seed a ticket in the ticket lookup (simulated via seedTicketSubject)
    const task = await createTaskFromTicket.execute({
      ticketId: TICKET_ID,
      ticketSubject: 'Internet down since Monday',
      customerId: CUSTOMER_ID,
      contractId: CONTRACT_ID,
      assigneeId: ASSIGNEE_ID,
      stageId: STAGE_ID,
      title: 'Internet down since Monday',
      description: 'Ticket ref: ticket-1',
      priority: 'high',
      estimatedHours: 2,
      category: 'support',
      coordinates: null,
      address: null,
      notes: null,
      completedAt: null,
      startDate: null,
      endDate: null,
      projectId: null,
      projectName: null,
      partnerId: null,
      reporterId: null,
      travelTimeTo: null,
      travelTimeFrom: null,
    });

    expect(task.ticketId).toBe(TICKET_ID);
    expect(task.ticketSubject).toBe('Internet down since Monday');
    expect(task.customerId).toBe(CUSTOMER_ID);
    expect(task.contractId).toBe(CONTRACT_ID);
  });

  it('rejects when ticket does not exist', async () => {
    const { createTaskFromTicket } = makeSetup();

    await expect(
      createTaskFromTicket.execute({
        ticketId: 'nonexistent-ticket',
        ticketSubject: 'Fake subject',
        customerId: CUSTOMER_ID,
        contractId: CONTRACT_ID,
        stageId: STAGE_ID,
        title: 'Test',
        description: null,
        priority: 'normal',
        estimatedHours: 1,
        category: 'support',
        coordinates: null,
        address: null,
        notes: null,
        completedAt: null,
        startDate: null,
        endDate: null,
        projectId: null,
        projectName: null,
        partnerId: null,
        reporterId: null,
        assigneeId: null,
        travelTimeTo: null,
        travelTimeFrom: null,
      }),
    ).rejects.toThrow(ReferenceNotFoundError);
  });

  it('rejects when contractId is missing', async () => {
    const { createTaskFromTicket } = makeSetup();

    // contractId is required in the input type — this tests the FK lookup rejects unknown contract
    await expect(
      createTaskFromTicket.execute({
        ticketId: TICKET_ID,
        ticketSubject: 'Internet down since Monday',
        customerId: CUSTOMER_ID,
        contractId: 'nonexistent-contract',
        stageId: STAGE_ID,
        title: 'Test',
        description: null,
        priority: 'normal',
        estimatedHours: 1,
        category: 'support',
        coordinates: null,
        address: null,
        notes: null,
        completedAt: null,
        startDate: null,
        endDate: null,
        projectId: null,
        projectName: null,
        partnerId: null,
        reporterId: null,
        assigneeId: null,
        travelTimeTo: null,
        travelTimeFrom: null,
      }),
    ).rejects.toThrow(ReferenceNotFoundError);
  });
});

describe('CreateTask with ticketLookup', () => {
  it('validates ticketId FK when ticketLookup provided and ticketId is set', async () => {
    const repo = new InMemorySchedulingRepository();
    const customerLookup = new InMemoryEntityLookup([{ id: CUSTOMER_ID }]);
    const contractLookup = new InMemoryEntityLookup([{ id: CONTRACT_ID }]);
    const partnerLookup = new InMemoryEntityLookup([]);
    const adminLookup = new InMemoryEntityLookup([]);
    const projectLookup = new InMemoryEntityLookup([]);
    // ticketLookup has no tickets
    const ticketLookup = new InMemoryEntityLookup([]);

    const createTask = new CreateTask(
      repo,
      customerLookup,
      contractLookup,
      partnerLookup,
      adminLookup,
      projectLookup,
      ticketLookup,
    );

    await expect(
      createTask.execute({
        title: 'Test task',
        description: null,
        stageId: STAGE_ID,
        priority: 'normal',
        estimatedHours: 1,
        category: 'support',
        customerId: CUSTOMER_ID,
        contractId: CONTRACT_ID,
        ticketId: 'nonexistent-ticket', // FK will fail
        coordinates: null,
        address: null,
        notes: null,
        completedAt: null,
        startDate: null,
        endDate: null,
        projectId: null,
        projectName: null,
        partnerId: null,
        reporterId: null,
        assigneeId: null,
        travelTimeTo: null,
        travelTimeFrom: null,
      }),
    ).rejects.toThrow(ReferenceNotFoundError);
  });

  it('skips ticket FK validation when ticketId is null (backward compat)', async () => {
    const repo = new InMemorySchedulingRepository();
    const customerLookup = new InMemoryEntityLookup([{ id: CUSTOMER_ID }]);
    const contractLookup = new InMemoryEntityLookup([{ id: CONTRACT_ID }]);
    const partnerLookup = new InMemoryEntityLookup([]);
    const adminLookup = new InMemoryEntityLookup([]);
    const projectLookup = new InMemoryEntityLookup([]);
    const ticketLookup = new InMemoryEntityLookup([]); // empty

    const createTask = new CreateTask(
      repo,
      customerLookup,
      contractLookup,
      partnerLookup,
      adminLookup,
      projectLookup,
      ticketLookup,
    );

    const task = await createTask.execute({
      title: 'No ticket task',
      description: null,
      stageId: STAGE_ID,
      priority: 'normal',
      estimatedHours: 1,
      category: 'support',
      customerId: CUSTOMER_ID,
      contractId: CONTRACT_ID,
      ticketId: null, // no ticket — skip validation
      coordinates: null,
      address: null,
      notes: null,
      completedAt: null,
      startDate: null,
      endDate: null,
      projectId: null,
      projectName: null,
      partnerId: null,
      reporterId: null,
      assigneeId: null,
      travelTimeTo: null,
      travelTimeFrom: null,
    });

    expect(task.ticketId).toBeNull();
  });

  it('skips ticket FK validation when ticketLookup is not provided (backward compat)', async () => {
    const repo = new InMemorySchedulingRepository();
    const customerLookup = new InMemoryEntityLookup([{ id: CUSTOMER_ID }]);
    const contractLookup = new InMemoryEntityLookup([{ id: CONTRACT_ID }]);
    const partnerLookup = new InMemoryEntityLookup([]);
    const adminLookup = new InMemoryEntityLookup([]);
    const projectLookup = new InMemoryEntityLookup([]);

    // No ticketLookup — old callers don't pass it
    const createTask = new CreateTask(
      repo,
      customerLookup,
      contractLookup,
      partnerLookup,
      adminLookup,
      projectLookup,
    );

    const task = await createTask.execute({
      title: 'Legacy task no ticket param',
      description: null,
      stageId: STAGE_ID,
      priority: 'normal',
      estimatedHours: 1,
      category: 'support',
      customerId: CUSTOMER_ID,
      contractId: CONTRACT_ID,
      ticketId: null,
      coordinates: null,
      address: null,
      notes: null,
      completedAt: null,
      startDate: null,
      endDate: null,
      projectId: null,
      projectName: null,
      partnerId: null,
      reporterId: null,
      assigneeId: null,
      travelTimeTo: null,
      travelTimeFrom: null,
    });

    expect(task.ticketId).toBeNull();
  });
});
