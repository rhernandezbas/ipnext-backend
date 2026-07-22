/**
 * bulk-task-recipients (B2.6, D2, TASK-3) — adapter-intention test with a mocked
 * Prisma client (molde `PrismaChatMessageRepository.upsertTemplateMessage.test.ts`).
 * Pins the exact shape `PrismaTaskRecipientSource` sends to
 * `prisma.scheduledTask`: `findMany` con `distinct: ['customerId']` +
 * `customerId: { not: null }` + `isClosed: false` para la resolución; `count` con
 * `customerId: null` + `isClosed: false` para el chip agregado honesto.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    scheduledTask: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaTaskRecipientSource } from '../../infrastructure/adapters/prisma/PrismaTaskRecipientSource';

const mockPrisma = prisma as unknown as {
  scheduledTask: { findMany: jest.Mock; count: jest.Mock };
};

describe('PrismaTaskRecipientSource (B2.6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('listClientIdsByOpenTaskStages pinea findMany distinct(customerId) con isClosed:false y customerId not null', async () => {
    mockPrisma.scheduledTask.findMany.mockResolvedValue([
      { customerId: 'c1' },
      { customerId: 'c2' },
    ]);

    const source = new PrismaTaskRecipientSource();
    const result = await source.listClientIdsByOpenTaskStages(['stageA', 'stageB']);

    expect(mockPrisma.scheduledTask.findMany).toHaveBeenCalledWith({
      where: { stageId: { in: ['stageA', 'stageB'] }, customerId: { not: null }, isClosed: false },
      select: { customerId: true },
      distinct: ['customerId'],
    });
    expect(result).toEqual(['c1', 'c2']);
  });

  it('countOpenTasksWithoutCustomer pinea count con customerId:null e isClosed:false', async () => {
    mockPrisma.scheduledTask.count.mockResolvedValue(3);

    const source = new PrismaTaskRecipientSource();
    const result = await source.countOpenTasksWithoutCustomer(['stageA']);

    expect(mockPrisma.scheduledTask.count).toHaveBeenCalledWith({
      where: { stageId: { in: ['stageA'] }, customerId: null, isClosed: false },
    });
    expect(result).toBe(3);
  });
});
