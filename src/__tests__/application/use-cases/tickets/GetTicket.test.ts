import { InMemoryTicketRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { GetTicket } from '../../../../application/use-cases/GetTicket';
import { CreateTicket } from '../../../../application/use-cases/CreateTicket';

describe('GetTicket use case', () => {
  it('returns the ticket when found', async () => {
    const repo = new InMemoryTicketRepository();
    const createTicket = new CreateTicket(repo);
    const getTicket = new GetTicket(repo);

    const created = await createTicket.execute({ subject: 'Test', description: 'Desc' });

    const result = await getTicket.execute(created.id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(created.id);
    expect(result?.subject).toBe('Test');
  });

  it('returns null when ticket not found', async () => {
    const repo = new InMemoryTicketRepository();
    const getTicket = new GetTicket(repo);

    const result = await getTicket.execute('non-existent-id');
    expect(result).toBeNull();
  });
});
