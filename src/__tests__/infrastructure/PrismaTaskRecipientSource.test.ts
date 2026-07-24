/**
 * bulk-task-recipients (B2.6, D2, TASK-3) + fix wave (F1, HIGH) — adapter-intention
 * test with a mocked Prisma client (molde
 * `PrismaChatMessageRepository.upsertTemplateMessage.test.ts`). Pins the exact shape
 * `PrismaTaskRecipientSource` sends to `prisma.scheduledTask`: `findMany` con
 * `distinct: ['customerId']` + `customerId: { not: null }` + `generalStatus: 'open'`
 * para la resolución; `count` con `customerId: null` + `generalStatus: 'open'` para
 * el chip agregado honesto.
 *
 * fix wave (F1) — el predicado usa `generalStatus`, NUNCA el flag legacy
 * `isClosed` (una tarea `generalStatus:'dismissed'` tiene `isClosed === false` —
 * `messaging.ts:227-228` — dejaba pasar tareas DESCARTADAS antes de este fix).
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

  it('listClientIdsByOpenTaskStages pinea findMany distinct(customerId) con generalStatus:open y customerId not null', async () => {
    mockPrisma.scheduledTask.findMany.mockResolvedValue([
      { customerId: 'c1' },
      { customerId: 'c2' },
    ]);

    const source = new PrismaTaskRecipientSource();
    const result = await source.listClientIdsByOpenTaskStages(['stageA', 'stageB']);

    expect(mockPrisma.scheduledTask.findMany).toHaveBeenCalledWith({
      where: { stageId: { in: ['stageA', 'stageB'] }, customerId: { not: null }, generalStatus: 'open' },
      select: { customerId: true },
      distinct: ['customerId'],
    });
    expect(result).toEqual(['c1', 'c2']);
  });

  it('countOpenTasksWithoutCustomer pinea count con customerId:null y generalStatus:open', async () => {
    mockPrisma.scheduledTask.count.mockResolvedValue(3);

    const source = new PrismaTaskRecipientSource();
    const result = await source.countOpenTasksWithoutCustomer(['stageA']);

    expect(mockPrisma.scheduledTask.count).toHaveBeenCalledWith({
      where: { stageId: { in: ['stageA'] }, customerId: null, generalStatus: 'open' },
    });
    expect(result).toBe(3);
  });

  it('bulk-task-stage-transition — listOpenTasksByStages: findMany SIN distinct (per-tarea), select id+customerId+stageId', async () => {
    mockPrisma.scheduledTask.findMany.mockResolvedValue([
      { id: 't10', customerId: 'c1', stageId: 'stageA' },
      { id: 't11', customerId: 'c1', stageId: 'stageA' },
    ]);

    const source = new PrismaTaskRecipientSource();
    const result = await source.listOpenTasksByStages(['stageA']);

    expect(mockPrisma.scheduledTask.findMany).toHaveBeenCalledWith({
      where: { stageId: { in: ['stageA'] }, customerId: { not: null }, generalStatus: 'open' },
      select: { id: true, customerId: true, stageId: true },
    });
    // per-tarea: 2 filas del mismo cliente, NO colapsadas
    expect(result).toEqual([
      { taskId: 't10', clientId: 'c1', fromStageId: 'stageA' },
      { taskId: 't11', clientId: 'c1', fromStageId: 'stageA' },
    ]);
    // el where NO lleva distinct
    expect(mockPrisma.scheduledTask.findMany.mock.calls[0]![0]).not.toHaveProperty('distinct');
  });

  it('fix wave (F1, HIGH) — NUNCA envía isClosed en el where (el flag legacy es engañoso: dismissed tiene isClosed:false)', async () => {
    mockPrisma.scheduledTask.findMany.mockResolvedValue([]);
    mockPrisma.scheduledTask.count.mockResolvedValue(0);

    const source = new PrismaTaskRecipientSource();
    await source.listClientIdsByOpenTaskStages(['stageA']);
    await source.countOpenTasksWithoutCustomer(['stageA']);

    const findManyWhere = mockPrisma.scheduledTask.findMany.mock.calls[0]![0].where;
    const countWhere = mockPrisma.scheduledTask.count.mock.calls[0]![0].where;
    expect(findManyWhere).not.toHaveProperty('isClosed');
    expect(countWhere).not.toHaveProperty('isClosed');
  });
});
