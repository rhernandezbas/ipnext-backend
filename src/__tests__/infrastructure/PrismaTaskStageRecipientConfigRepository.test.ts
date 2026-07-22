/**
 * bulk-task-recipients (B2.5, D2) — adapter-intention test with a mocked Prisma
 * client (molde `PrismaChatMessageRepository.upsertTemplateMessage.test.ts`). Pins
 * the shape `PrismaTaskStageRecipientConfigRepository` sends to
 * `prisma.whatsappTaskStageRecipientConfig`: `getMappedStages` hydrates via
 * `findMany({ include: { stage: { include: { workflow: true } } } })`;
 * `replaceMappedStages` is ATOMIC (`$transaction([deleteMany, createMany])`) — a
 * simulated P2003 (FK violation, unknown stageId) is translated to
 * `TaskStageNotFoundError`, NEVER let the raw Prisma error escape.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    whatsappTaskStageRecipientConfig: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaTaskStageRecipientConfigRepository } from '../../infrastructure/adapters/prisma/PrismaTaskStageRecipientConfigRepository';
import { TaskStageNotFoundError } from '../../domain/errors/messaging-task-stage-config';

const mockPrisma = prisma as unknown as {
  whatsappTaskStageRecipientConfig: {
    findMany: jest.Mock;
    deleteMany: jest.Mock;
    createMany: jest.Mock;
  };
  $transaction: jest.Mock;
};

describe('PrismaTaskStageRecipientConfigRepository (B2.5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('listMappedStageIds pinea findMany({ select: { stageId: true } }) y mapea al array de ids', async () => {
    mockPrisma.whatsappTaskStageRecipientConfig.findMany.mockResolvedValue([
      { stageId: 'stageA' },
      { stageId: 'stageB' },
    ]);

    const repo = new PrismaTaskStageRecipientConfigRepository();
    const result = await repo.listMappedStageIds();

    expect(mockPrisma.whatsappTaskStageRecipientConfig.findMany).toHaveBeenCalledWith({
      select: { stageId: true },
    });
    expect(result).toEqual(['stageA', 'stageB']);
  });

  it('getMappedStages pinea findMany({ include: { stage: { include: { workflow: true } } } }) e hidrata MappedStage[]', async () => {
    mockPrisma.whatsappTaskStageRecipientConfig.findMany.mockResolvedValue([
      {
        stageId: 'stageA',
        stage: {
          name: 'En progreso',
          code: 'en-progreso',
          color: '#222222',
          workflowId: 'wf-1',
          workflow: { name: 'Instalaciones' },
        },
      },
    ]);

    const repo = new PrismaTaskStageRecipientConfigRepository();
    const result = await repo.getMappedStages();

    expect(mockPrisma.whatsappTaskStageRecipientConfig.findMany).toHaveBeenCalledWith({
      include: { stage: { include: { workflow: true } } },
    });
    expect(result).toEqual([
      {
        stageId: 'stageA',
        stageName: 'En progreso',
        stageCode: 'en-progreso',
        color: '#222222',
        workflowId: 'wf-1',
        workflowName: 'Instalaciones',
      },
    ]);
  });

  it('replaceMappedStages pinea $transaction([deleteMany({}), createMany({ data: stageIds.map(id=>({stageId:id})) })])', async () => {
    mockPrisma.$transaction.mockResolvedValue([{ count: 2 }, { count: 2 }]);

    const repo = new PrismaTaskStageRecipientConfigRepository();
    await repo.replaceMappedStages(['s1', 's2']);

    expect(mockPrisma.whatsappTaskStageRecipientConfig.deleteMany).toHaveBeenCalledWith({});
    expect(mockPrisma.whatsappTaskStageRecipientConfig.createMany).toHaveBeenCalledWith({
      data: [{ stageId: 's1' }, { stageId: 's2' }],
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledWith([
      mockPrisma.whatsappTaskStageRecipientConfig.deleteMany.mock.results[0].value,
      mockPrisma.whatsappTaskStageRecipientConfig.createMany.mock.results[0].value,
    ]);
  });

  it('un P2003 simulado en $transaction se traduce a TaskStageNotFoundError — nunca escapa el error crudo de Prisma', async () => {
    mockPrisma.$transaction.mockRejectedValue(
      Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' }),
    );

    const repo = new PrismaTaskStageRecipientConfigRepository();

    await expect(repo.replaceMappedStages(['s1', 'stage-inexistente'])).rejects.toBeInstanceOf(
      TaskStageNotFoundError,
    );
  });

  it('un error de OTRO código en $transaction propaga tal cual (no lo absorbe por error)', async () => {
    mockPrisma.$transaction.mockRejectedValue(Object.assign(new Error('boom'), { code: 'P9999' }));

    const repo = new PrismaTaskStageRecipientConfigRepository();

    await expect(repo.replaceMappedStages(['s1'])).rejects.toMatchObject({ code: 'P9999' });
  });
});
