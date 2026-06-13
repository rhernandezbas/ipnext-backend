import { InMemoryTicketRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { CreateTicket } from '../../../../application/use-cases/CreateTicket';
import { ListTickets } from '../../../../application/use-cases/ListTickets';

describe('CreateTicket use case', () => {
  it('persists ticket with customerId and resolves customerName from JOIN', async () => {
    const repo = new InMemoryTicketRepository();
    repo.seedCustomers([{ id: 'c1', name: 'Alice García' }]);
    const createTicket = new CreateTicket(repo);

    const ticket = await createTicket.execute({
      subject: 'Sin señal',
      description: 'No hay servicio',
      customerId: 'c1',
      priority: 'high',
    });

    expect(ticket.customerId).toBe('c1');
    expect(ticket.customerName).toBe('Alice García');
    expect(ticket.status).toBe('open');
    expect(ticket.priority).toBe('high');
    expect(ticket.id).toBeTruthy();
  });

  it('creates ticket without customerId (customerName is null)', async () => {
    const repo = new InMemoryTicketRepository();
    const createTicket = new CreateTicket(repo);

    const ticket = await createTicket.execute({
      subject: 'Internal ticket',
      description: 'No client',
    });

    expect(ticket.customerId).toBeNull();
    expect(ticket.customerName).toBeNull();
  });

  it('appears in listTickets after create', async () => {
    const repo = new InMemoryTicketRepository();
    repo.seedCustomers([{ id: 'c1', name: 'Alice García' }]);
    const createTicket = new CreateTicket(repo);
    const listTickets = new ListTickets(repo);

    await createTicket.execute({ subject: 'T1', description: 'D1', customerId: 'c1' });

    const result = await listTickets.execute({ page: 1, limit: 25, customerId: 'c1' });
    expect(result.total).toBe(1);
    expect(result.data[0]?.customerName).toBe('Alice García');
  });

  it('propagates errors from repo', async () => {
    const badRepo = {
      list: jest.fn(),
      getById: jest.fn(),
      getStats: jest.fn(),
      create: jest.fn().mockRejectedValue(new Error('DB error')),
      update: jest.fn(),
      close: jest.fn(),
      archive: jest.fn(),
      delete: jest.fn(),
    };
    const createTicket = new CreateTicket(badRepo);

    await expect(
      createTicket.execute({ subject: 'x', description: 'y' })
    ).rejects.toThrow('DB error');
  });
});
