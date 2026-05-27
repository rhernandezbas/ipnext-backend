import { InMemoryTicketRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { UpdateTicketStatus } from '../../../../application/use-cases/UpdateTicketStatus';
import { CloseTicket } from '../../../../application/use-cases/CloseTicket';
import { CreateTicket } from '../../../../application/use-cases/CreateTicket';

describe('UpdateTicketStatus use case', () => {
  it('changes status to pending', async () => {
    const repo = new InMemoryTicketRepository();
    const createTicket = new CreateTicket(repo);
    const updateStatus = new UpdateTicketStatus(repo);

    const created = await createTicket.execute({ subject: 'T', description: 'D' });
    expect(created.status).toBe('open');

    const updated = await updateStatus.execute(created.id, 'pending');
    expect(updated?.status).toBe('pending');
  });

  it('returns null for non-existent ticket', async () => {
    const repo = new InMemoryTicketRepository();
    const updateStatus = new UpdateTicketStatus(repo);

    const result = await updateStatus.execute('no-such-id', 'pending');
    expect(result).toBeNull();
  });

  it('persists the status change (not just in-memory override)', async () => {
    const repo = new InMemoryTicketRepository();
    const createTicket = new CreateTicket(repo);
    const updateStatus = new UpdateTicketStatus(repo);

    const created = await createTicket.execute({ subject: 'T', description: 'D' });
    await updateStatus.execute(created.id, 'pending');

    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe('pending');
  });
});

describe('CloseTicket use case', () => {
  it('sets status to closed', async () => {
    const repo = new InMemoryTicketRepository();
    const createTicket = new CreateTicket(repo);
    const closeTicket = new CloseTicket(repo);

    const created = await createTicket.execute({ subject: 'T', description: 'D' });
    const closed = await closeTicket.execute(created.id);
    expect(closed?.status).toBe('closed');
  });

  it('persists the closed status', async () => {
    const repo = new InMemoryTicketRepository();
    const createTicket = new CreateTicket(repo);
    const closeTicket = new CloseTicket(repo);

    const created = await createTicket.execute({ subject: 'T', description: 'D' });
    await closeTicket.execute(created.id);

    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe('closed');
  });

  it('returns null for non-existent ticket', async () => {
    const repo = new InMemoryTicketRepository();
    const closeTicket = new CloseTicket(repo);

    const result = await closeTicket.execute('no-such-id');
    expect(result).toBeNull();
  });
});
