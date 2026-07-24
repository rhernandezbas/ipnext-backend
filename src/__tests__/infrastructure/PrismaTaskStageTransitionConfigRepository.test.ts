/**
 * bulk-task-stage-transition (B1.5, D1) — adapter-intention test con prisma mockeado
 * (molde `PrismaTaskStageRecipientConfigRepository.test.ts`). Pinnea la shape que
 * `PrismaTaskStageTransitionConfigRepository` envía a `prisma.whatsappTaskStageTransitionConfig`:
 * el singleton por id 'singleton', el UPSERT, y la hidratación por include.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    whatsappTaskStageTransitionConfig: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaTaskStageTransitionConfigRepository } from '../../infrastructure/adapters/prisma/PrismaTaskStageTransitionConfigRepository';

const mockPrisma = prisma as unknown as {
  whatsappTaskStageTransitionConfig: { findUnique: jest.Mock; upsert: jest.Mock };
};

describe('PrismaTaskStageTransitionConfigRepository', () => {
  beforeEach(() => jest.clearAllMocks());

  it('getResultingStageId → findUnique por id singleton, devuelve el id', async () => {
    mockPrisma.whatsappTaskStageTransitionConfig.findUnique.mockResolvedValue({ resultingStageId: 'sB' });
    const repo = new PrismaTaskStageTransitionConfigRepository();

    expect(await repo.getResultingStageId()).toBe('sB');
    expect(mockPrisma.whatsappTaskStageTransitionConfig.findUnique).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      select: { resultingStageId: true },
    });
  });

  it('getResultingStageId → sin fila devuelve null', async () => {
    mockPrisma.whatsappTaskStageTransitionConfig.findUnique.mockResolvedValue(null);
    const repo = new PrismaTaskStageTransitionConfigRepository();
    expect(await repo.getResultingStageId()).toBeNull();
  });

  it('getResultingStage → hidrata por include stage+workflow', async () => {
    mockPrisma.whatsappTaskStageTransitionConfig.findUnique.mockResolvedValue({
      resultingStageId: 'sB',
      resultingStage: { id: 'sB', name: 'Avisado', code: 'avisado', color: '#0a0', workflowId: 'w1', workflow: { name: 'Instalaciones' } },
    });
    const repo = new PrismaTaskStageTransitionConfigRepository();

    expect(await repo.getResultingStage()).toEqual({
      stageId: 'sB', stageName: 'Avisado', stageCode: 'avisado', color: '#0a0', workflowId: 'w1', workflowName: 'Instalaciones',
    });
    expect(mockPrisma.whatsappTaskStageTransitionConfig.findUnique).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      include: { resultingStage: { include: { workflow: true } } },
    });
  });

  it('getResultingStage → sin resultingStage (borrado/SetNull) devuelve null', async () => {
    mockPrisma.whatsappTaskStageTransitionConfig.findUnique.mockResolvedValue({ resultingStageId: null, resultingStage: null });
    const repo = new PrismaTaskStageTransitionConfigRepository();
    expect(await repo.getResultingStage()).toBeNull();
  });

  it('setResultingStageId → UPSERT por id singleton (create+update)', async () => {
    mockPrisma.whatsappTaskStageTransitionConfig.upsert.mockResolvedValue({});
    const repo = new PrismaTaskStageTransitionConfigRepository();

    await repo.setResultingStageId('sB');
    expect(mockPrisma.whatsappTaskStageTransitionConfig.upsert).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      create: { id: 'singleton', resultingStageId: 'sB' },
      update: { resultingStageId: 'sB' },
    });
  });

  it('setResultingStageId(null) → UPSERT con null (limpia)', async () => {
    mockPrisma.whatsappTaskStageTransitionConfig.upsert.mockResolvedValue({});
    const repo = new PrismaTaskStageTransitionConfigRepository();

    await repo.setResultingStageId(null);
    expect(mockPrisma.whatsappTaskStageTransitionConfig.upsert).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      create: { id: 'singleton', resultingStageId: null },
      update: { resultingStageId: null },
    });
  });
});
