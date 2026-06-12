import { CreateTicket } from '../../application/use-cases/CreateTicket';
import type { TicketRepository, CreateTicketData } from '../../domain/ports/TicketRepository';
import type { Ticket } from '../../domain/entities/ticket';

const mockTicket: Ticket = {
  id: '1',
  sequenceNumber: 1,
  subject: 'Internet caído',
  description: 'No hay señal.',
  customerId: 'c42',
  customerName: 'Alice García',
  assigneeId: null,
  assigneeName: null,
  reporterId: null,
  reporterName: null,
  areaId: null,      // #49
  areaName: null,    // #49
  grCasoId: null,
  priority: 'high',
  status: 'open',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

function makeRepo(overrides?: Partial<TicketRepository>): TicketRepository {
  return {
    list: jest.fn(),
    getById: jest.fn(),
    getStats: jest.fn(),
    create: jest.fn().mockResolvedValue(mockTicket),
    update: jest.fn(),
    close: jest.fn(),
    ...overrides,
  };
}

describe('CreateTicket', () => {
  it('calls repo.create with the given data', async () => {
    const repo = makeRepo();
    const uc = new CreateTicket(repo);
    const data: CreateTicketData = {
      subject: 'Internet caído',
      description: 'No hay señal.',
      customerId: 'c42',
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
      uc.execute({ subject: 'x', description: 'y' })
    ).rejects.toThrow('Upstream error');
  });

  it('passes optional assigneeId field', async () => {
    const repo = makeRepo();
    const uc = new CreateTicket(repo);

    await uc.execute({
      subject: 'Test',
      description: 'Test',
      assigneeId: 'admin-7',
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: 'admin-7' })
    );
  });

  it('passes optional customerId field', async () => {
    const repo = makeRepo();
    const uc = new CreateTicket(repo);

    await uc.execute({
      subject: 'Test',
      description: 'Test',
      customerId: 'client-5',
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'client-5' })
    );
  });
});
