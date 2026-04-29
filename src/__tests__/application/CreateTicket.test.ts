import { CreateTicket } from '../../application/use-cases/CreateTicket';
import type { TicketRepository, CreateTicketData } from '../../domain/ports/TicketRepository';
import type { Ticket } from '../../domain/entities/ticket';

const mockTicket: Ticket = {
  id: '1',
  subject: 'Internet caído',
  clientId: '42',
  clientName: 'Alice García',
  priority: 'alta',
  status: 'abierto',
  description: 'No hay señal.',
  createdAt: '2024-01-01',
};

function makeRepo(overrides?: Partial<TicketRepository>): TicketRepository {
  return {
    list: jest.fn(),
    getStats: jest.fn(),
    create: jest.fn().mockResolvedValue(mockTicket),
    ...overrides,
  };
}

describe('CreateTicket', () => {
  it('calls repo.create with the given data', async () => {
    const repo = makeRepo();
    const uc = new CreateTicket(repo);
    const data: CreateTicketData = {
      subject: 'Internet caído',
      clientId: '42',
      priority: 'alta',
      description: 'No hay señal.',
    };

    const result = await uc.execute(data);

    expect(repo.create).toHaveBeenCalledWith(data);
    expect(result).toEqual(mockTicket);
  });

  it('propagates errors from repo.create', async () => {
    const repo = makeRepo({
      create: jest.fn().mockRejectedValue(new Error('Upstream error')),
    });
    const uc = new CreateTicket(repo);

    await expect(
      uc.execute({ subject: 'x', clientId: '1', priority: 'baja', description: 'y' })
    ).rejects.toThrow('Upstream error');
  });

  it('passes optional assignedTo field', async () => {
    const repo = makeRepo();
    const uc = new CreateTicket(repo);

    await uc.execute({
      subject: 'Test',
      clientId: '1',
      priority: 'media',
      description: 'Test',
      assignedTo: 'agent-7',
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ assignedTo: 'agent-7' })
    );
  });
});
