import { InMemoryServiceTechnologyRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceTechnologyRepository';
import { ListServiceTechnology } from '@application/use-cases/ListServiceTechnology';
import { GetServiceTechnology } from '@application/use-cases/GetServiceTechnology';
import { CreateServiceTechnology } from '@application/use-cases/CreateServiceTechnology';
import { UpdateServiceTechnology } from '@application/use-cases/UpdateServiceTechnology';
import { DeleteServiceTechnology } from '@application/use-cases/DeleteServiceTechnology';
import {
  ServiceTechnologyNotFoundError,
  ServiceTechnologyNameConflictError,
  ServiceTechnologyInUseError,
} from '@domain/errors/serviceTechnology';

describe('ServiceTechnology use cases', () => {
  let repo: InMemoryServiceTechnologyRepository;
  let list: ListServiceTechnology;
  let get: GetServiceTechnology;
  let create: CreateServiceTechnology;
  let update: UpdateServiceTechnology;
  let del: DeleteServiceTechnology;

  beforeEach(() => {
    repo = new InMemoryServiceTechnologyRepository();
    list = new ListServiceTechnology(repo);
    get = new GetServiceTechnology(repo);
    create = new CreateServiceTechnology(repo);
    update = new UpdateServiceTechnology(repo);
    del = new DeleteServiceTechnology(repo);
  });

  it('lists empty initially', async () => {
    expect(await list.execute()).toEqual([]);
  });

  it('creates and retrieves a technology', async () => {
    const created = await create.execute({ name: 'Fiber' });
    const got = await get.execute(created.id);
    expect(got.name).toBe('Fiber');
    expect(await list.execute()).toHaveLength(1);
  });

  it('creates with optional description', async () => {
    const created = await create.execute({ name: 'DOCSIS', description: 'Cable HFC' });
    expect(created.description).toBe('Cable HFC');
  });

  it('rejects duplicate name (case-insensitive)', async () => {
    await create.execute({ name: 'Fiber' });
    await expect(create.execute({ name: 'fiber' })).rejects.toBeInstanceOf(ServiceTechnologyNameConflictError);
  });

  it('throws when getting an unknown id', async () => {
    await expect(get.execute('nope')).rejects.toBeInstanceOf(ServiceTechnologyNotFoundError);
  });

  it('updates the name', async () => {
    const created = await create.execute({ name: 'Wireless' });
    const updated = await update.execute(created.id, { name: 'Wireless 5GHz' });
    expect(updated.name).toBe('Wireless 5GHz');
  });

  it('updates the description', async () => {
    const created = await create.execute({ name: 'FTTH' });
    const updated = await update.execute(created.id, { description: 'Fiber to the home' });
    expect(updated.description).toBe('Fiber to the home');
    expect(updated.name).toBe('FTTH'); // name unchanged
  });

  it('update rejects a name that collides with another technology', async () => {
    await create.execute({ name: 'Fiber' });
    const b = await create.execute({ name: 'DOCSIS' });
    await expect(update.execute(b.id, { name: 'Fiber' })).rejects.toBeInstanceOf(ServiceTechnologyNameConflictError);
  });

  it('update throws NotFound for unknown id', async () => {
    await expect(update.execute('ghost', { name: 'X' })).rejects.toBeInstanceOf(ServiceTechnologyNotFoundError);
  });

  it('deletes a technology', async () => {
    const created = await create.execute({ name: 'HFC' });
    await del.execute(created.id);
    expect(await list.execute()).toHaveLength(0);
  });

  it('delete throws NotFound for unknown id', async () => {
    await expect(del.execute('ghost')).rejects.toBeInstanceOf(ServiceTechnologyNotFoundError);
  });

  it('refuses to delete a technology in use by services', async () => {
    const created = await create.execute({ name: 'Radio' });
    repo.serviceCounts['Radio'] = 5;
    await expect(del.execute(created.id)).rejects.toBeInstanceOf(ServiceTechnologyInUseError);
  });
});
