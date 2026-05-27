import { InMemoryTicketStatusRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketStatusRepository';
import { ListTicketStatuses } from '@application/use-cases/ListTicketStatuses';
import { GetTicketStatus } from '@application/use-cases/GetTicketStatus';
import { CreateTicketStatus } from '@application/use-cases/CreateTicketStatus';
import { UpdateTicketStatusCatalog } from '@application/use-cases/UpdateTicketStatusCatalog';
import { DeleteTicketStatus } from '@application/use-cases/DeleteTicketStatus';
import {
  TicketStatusNotFoundError,
  TicketStatusNameConflictError,
  TicketStatusInUseError,
} from '@domain/errors/tickets';

describe('TicketStatus use cases', () => {
  let repo: InMemoryTicketStatusRepository;
  let list: ListTicketStatuses;
  let get: GetTicketStatus;
  let create: CreateTicketStatus;
  let update: UpdateTicketStatusCatalog;
  let del: DeleteTicketStatus;

  beforeEach(() => {
    repo = new InMemoryTicketStatusRepository();
    list = new ListTicketStatuses(repo);
    get = new GetTicketStatus(repo);
    create = new CreateTicketStatus(repo);
    update = new UpdateTicketStatusCatalog(repo);
    del = new DeleteTicketStatus(repo);
  });

  it('creates with color + weight and lists ordered by weight', async () => {
    await create.execute({ name: 'open', color: '#22c55e', weight: 1 });
    await create.execute({ name: 'closed', color: '#94a3b8', weight: 3 });
    await create.execute({ name: 'pending', color: '#f59e0b', weight: 2 });
    const all = await list.execute();
    expect(all.map(s => s.name)).toEqual(['open', 'pending', 'closed']); // sorted by weight asc
    expect(all[0].color).toBe('#22c55e');
  });

  it('rejects duplicate name (case-insensitive)', async () => {
    await create.execute({ name: 'Open', color: '#22c55e', weight: 1 });
    await expect(create.execute({ name: 'open', color: '#000', weight: 9 })).rejects.toBeInstanceOf(TicketStatusNameConflictError);
  });

  it('throws when getting unknown id', async () => {
    await expect(get.execute('nope')).rejects.toBeInstanceOf(TicketStatusNotFoundError);
  });

  it('updates color and weight', async () => {
    const s = await create.execute({ name: 'open', color: '#22c55e', weight: 1 });
    const updated = await update.execute(s.id, { color: '#16a34a', weight: 2 });
    expect(updated.color).toBe('#16a34a');
    expect(updated.weight).toBe(2);
  });

  it('update rejects a name colliding with another status', async () => {
    await create.execute({ name: 'open', color: '#22c55e', weight: 1 });
    const s = await create.execute({ name: 'pending', color: '#f59e0b', weight: 2 });
    await expect(update.execute(s.id, { name: 'open' })).rejects.toBeInstanceOf(TicketStatusNameConflictError);
  });

  it('refuses to delete a status in use by tickets', async () => {
    const s = await create.execute({ name: 'open', color: '#22c55e', weight: 1 });
    repo.ticketCounts['open'] = 5;
    await expect(del.execute(s.id)).rejects.toBeInstanceOf(TicketStatusInUseError);
  });

  it('deletes an unused status', async () => {
    const s = await create.execute({ name: 'draft', color: '#000', weight: 9 });
    await del.execute(s.id);
    expect(await list.execute()).toHaveLength(0);
  });
});
