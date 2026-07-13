import { InMemoryTicketRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { CreateTicket } from '../../../../application/use-cases/CreateTicket';
import { ListTickets } from '../../../../application/use-cases/ListTickets';
import { ReferenceNotFoundError, ContractCustomerMismatchError } from '../../../../domain/errors/scheduling';

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
      countOpenByClientIds: jest.fn(),
      countClosedByClientIds: jest.fn(),
    };
    const createTicket = new CreateTicket(badRepo);

    await expect(
      createTicket.execute({ subject: 'x', description: 'y' })
    ).rejects.toThrow('DB error');
  });
});

describe('CreateTicket — contract requirement (FK + ownership)', () => {
  function buildRepo() {
    const repo = new InMemoryTicketRepository();
    repo.seedCustomers([
      { id: 'c1', name: 'Alice García' },
      { id: 'c2', name: 'Bob Martínez' },
    ]);
    // ct1 belongs to c1; ct2 belongs to c2.
    repo.seedContracts([
      { id: 'ct1', clientId: 'c1' },
      { id: 'ct2', clientId: 'c2' },
    ]);
    return repo;
  }

  function buildUseCase(repo: InMemoryTicketRepository) {
    return new CreateTicket(repo, repo.customerLookup(), repo.contractLookup());
  }

  it('creates the ticket when customerId + contractId are valid and the contract belongs to the customer', async () => {
    const repo = buildRepo();
    const uc = buildUseCase(repo);

    const ticket = await uc.execute({
      subject: 'Sin señal',
      description: 'No hay servicio',
      customerId: 'c1',
      contractId: 'ct1',
    });

    expect(ticket.customerId).toBe('c1');
    expect(ticket.contractId).toBe('ct1');
    expect(ticket.id).toBeTruthy();
  });

  it('rejects with ReferenceNotFoundError(customer) when customerId is missing', async () => {
    const repo = buildRepo();
    const uc = buildUseCase(repo);

    await expect(
      uc.execute({ subject: 'S', description: 'D', contractId: 'ct1' }),
    ).rejects.toBeInstanceOf(ReferenceNotFoundError);
  });

  it('rejects with ReferenceNotFoundError(contract) when contractId is missing', async () => {
    const repo = buildRepo();
    const uc = buildUseCase(repo);

    await expect(
      uc.execute({ subject: 'S', description: 'D', customerId: 'c1' }),
    ).rejects.toMatchObject({ name: 'ReferenceNotFoundError', kind: 'contract' });
  });

  it('rejects with ReferenceNotFoundError(contract) when contractId does not exist', async () => {
    const repo = buildRepo();
    const uc = buildUseCase(repo);

    await expect(
      uc.execute({ subject: 'S', description: 'D', customerId: 'c1', contractId: 'ghost' }),
    ).rejects.toMatchObject({ name: 'ReferenceNotFoundError', kind: 'contract' });
  });

  it('rejects with ContractCustomerMismatchError when the contract belongs to another customer', async () => {
    const repo = buildRepo();
    const uc = buildUseCase(repo);

    // ct2 belongs to c2, not c1 → mismatch.
    await expect(
      uc.execute({ subject: 'S', description: 'D', customerId: 'c1', contractId: 'ct2' }),
    ).rejects.toBeInstanceOf(ContractCustomerMismatchError);
  });

  it('skips validation entirely when lookups are NOT wired (back-compat for direct fixtures)', async () => {
    const repo = buildRepo();
    const uc = new CreateTicket(repo); // no lookups

    const ticket = await uc.execute({ subject: 'S', description: 'D' });
    expect(ticket.id).toBeTruthy();
    expect(ticket.contractId).toBeNull();
  });
});
