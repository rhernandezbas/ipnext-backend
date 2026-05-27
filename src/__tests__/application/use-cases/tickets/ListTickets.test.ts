import { InMemoryTicketRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { ListTickets } from '../../../../application/use-cases/ListTickets';
import { CreateTicket } from '../../../../application/use-cases/CreateTicket';

describe('ListTickets use case', () => {
  function setup() {
    const repo = new InMemoryTicketRepository();
    repo.seedCustomers([
      { id: 'c1', name: 'Alice García' },
      { id: 'c2', name: 'Bob Martínez' },
    ]);
    const listTickets = new ListTickets(repo);
    const createTicket = new CreateTicket(repo);
    return { repo, listTickets, createTicket };
  }

  it('returns all tickets when no filter', async () => {
    const { listTickets, createTicket } = setup();
    await createTicket.execute({ subject: 'T1', description: 'D1', customerId: 'c1' });
    await createTicket.execute({ subject: 'T2', description: 'D2', customerId: 'c2' });

    const result = await listTickets.execute({ page: 1, limit: 25 });
    expect(result.total).toBe(2);
    expect(result.data).toHaveLength(2);
  });

  it('filters by customerId and returns only that customer tickets', async () => {
    const { listTickets, createTicket } = setup();
    await createTicket.execute({ subject: 'T1', description: 'D1', customerId: 'c1' });
    await createTicket.execute({ subject: 'T2', description: 'D2', customerId: 'c2' });
    await createTicket.execute({ subject: 'T3', description: 'D3', customerId: 'c1' });

    const result = await listTickets.execute({ page: 1, limit: 25, customerId: 'c1' });
    expect(result.total).toBe(2);
    expect(result.data.every((t) => t.customerId === 'c1')).toBe(true);
  });

  it('returns correct total when filtering by customerId', async () => {
    const { listTickets, createTicket } = setup();
    await createTicket.execute({ subject: 'T1', description: 'D1', customerId: 'c1' });
    await createTicket.execute({ subject: 'T2', description: 'D2', customerId: 'c1' });

    const result = await listTickets.execute({ page: 1, limit: 25, customerId: 'c1' });
    expect(result.total).toBe(2);
  });

  it('returns empty when customerId has no tickets', async () => {
    const { listTickets, createTicket } = setup();
    await createTicket.execute({ subject: 'T1', description: 'D1', customerId: 'c1' });

    const result = await listTickets.execute({ page: 1, limit: 25, customerId: 'c2' });
    expect(result.total).toBe(0);
    expect(result.data).toHaveLength(0);
  });
});
