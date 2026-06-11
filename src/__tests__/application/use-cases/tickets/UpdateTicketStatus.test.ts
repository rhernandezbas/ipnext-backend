import { InMemoryTicketRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketStatusRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryTicketStatusRepository';
import { UpdateTicketStatus } from '../../../../application/use-cases/UpdateTicketStatus';
import { CloseTicket } from '../../../../application/use-cases/CloseTicket';
import { CreateTicket } from '../../../../application/use-cases/CreateTicket';
import { NoClosableStatusError } from '../../../../domain/errors/tickets';

function statusRepoWith(...names: string[]): InMemoryTicketStatusRepository {
  const repo = new InMemoryTicketStatusRepository();
  names.forEach((name, i) => void repo.create({ name, color: '#000', weight: i }));
  return repo;
}

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
    const closeTicket = new CloseTicket(repo, statusRepoWith('open', 'closed'));

    const created = await createTicket.execute({ subject: 'T', description: 'D' });
    const closed = await closeTicket.execute(created.id);
    expect(closed?.status).toBe('closed');
  });

  it('persists the closed status', async () => {
    const repo = new InMemoryTicketRepository();
    const createTicket = new CreateTicket(repo);
    const closeTicket = new CloseTicket(repo, statusRepoWith('open', 'closed'));

    const created = await createTicket.execute({ subject: 'T', description: 'D' });
    await closeTicket.execute(created.id);

    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe('closed');
  });

  it('M1 (#46): uses the catalog canonical name when only "Cerrado" exists', async () => {
    const repo = new InMemoryTicketRepository();
    const createTicket = new CreateTicket(repo);
    const closeTicket = new CloseTicket(repo, statusRepoWith('Abierto', 'Cerrado'));

    const created = await createTicket.execute({ subject: 'T', description: 'D' });
    const closed = await closeTicket.execute(created.id);
    expect(closed?.status).toBe('Cerrado');
  });

  it('M1 (#46): throws NoClosableStatusError when no closed-like status exists', async () => {
    const repo = new InMemoryTicketRepository();
    const createTicket = new CreateTicket(repo);
    const closeTicket = new CloseTicket(repo, statusRepoWith('open'));

    const created = await createTicket.execute({ subject: 'T', description: 'D' });
    await expect(closeTicket.execute(created.id)).rejects.toBeInstanceOf(NoClosableStatusError);
  });

  it('returns null for non-existent ticket', async () => {
    const repo = new InMemoryTicketRepository();
    const closeTicket = new CloseTicket(repo, statusRepoWith('closed'));

    const result = await closeTicket.execute('no-such-id');
    expect(result).toBeNull();
  });
});
