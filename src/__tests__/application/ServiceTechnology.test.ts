import { InMemoryContractTechnologyRepository } from '@infrastructure/adapters/in-memory/InMemoryContractTechnologyRepository';
import { ListContractTechnology } from '@application/use-cases/ListContractTechnology';
import { GetContractTechnology } from '@application/use-cases/GetContractTechnology';
import { CreateContractTechnology } from '@application/use-cases/CreateContractTechnology';
import { UpdateContractTechnology } from '@application/use-cases/UpdateContractTechnology';
import { DeleteContractTechnology } from '@application/use-cases/DeleteContractTechnology';
import {
  ContractTechnologyNotFoundError,
  ContractTechnologyNameConflictError,
  ContractTechnologyInUseError,
} from '@domain/errors/contractTechnology';

describe('ContractTechnology use cases', () => {
  let repo: InMemoryContractTechnologyRepository;
  let list: ListContractTechnology;
  let get: GetContractTechnology;
  let create: CreateContractTechnology;
  let update: UpdateContractTechnology;
  let del: DeleteContractTechnology;

  beforeEach(() => {
    repo = new InMemoryContractTechnologyRepository();
    list = new ListContractTechnology(repo);
    get = new GetContractTechnology(repo);
    create = new CreateContractTechnology(repo);
    update = new UpdateContractTechnology(repo);
    del = new DeleteContractTechnology(repo);
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
    await expect(create.execute({ name: 'fiber' })).rejects.toBeInstanceOf(ContractTechnologyNameConflictError);
  });

  it('throws when getting an unknown id', async () => {
    await expect(get.execute('nope')).rejects.toBeInstanceOf(ContractTechnologyNotFoundError);
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
    await expect(update.execute(b.id, { name: 'Fiber' })).rejects.toBeInstanceOf(ContractTechnologyNameConflictError);
  });

  it('update throws NotFound for unknown id', async () => {
    await expect(update.execute('ghost', { name: 'X' })).rejects.toBeInstanceOf(ContractTechnologyNotFoundError);
  });

  it('deletes a technology', async () => {
    const created = await create.execute({ name: 'HFC' });
    await del.execute(created.id);
    expect(await list.execute()).toHaveLength(0);
  });

  it('delete throws NotFound for unknown id', async () => {
    await expect(del.execute('ghost')).rejects.toBeInstanceOf(ContractTechnologyNotFoundError);
  });

  it('refuses to delete a technology in use by contracts', async () => {
    const created = await create.execute({ name: 'Radio' });
    repo.contractCounts['Radio'] = 5;
    await expect(del.execute(created.id)).rejects.toBeInstanceOf(ContractTechnologyInUseError);
  });

  // W1: InMemory adapter must order by name ascending, matching the Prisma adapter (orderBy name asc).
  it('lists technologies ordered by name ascending', async () => {
    await create.execute({ name: 'Wireless' });
    await create.execute({ name: 'DOCSIS' });
    await create.execute({ name: 'Fiber' });
    const names = (await list.execute()).map((t) => t.name);
    expect(names).toEqual(['DOCSIS', 'Fiber', 'Wireless']);
  });
});
