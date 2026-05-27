/**
 * Unit tests for PrismaSchedulingRepository method behaviors
 * WARNING 4: moveTaskToStage throws StageNotFoundError when target stageId doesn't exist
 */

// Mock the prisma singleton BEFORE importing anything that uses it
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    stage: {
      findUnique: jest.fn(),
    },
    scheduledTask: {
      update: jest.fn(),
      findUnique: jest.fn(),
    },
  },
}));

import { PrismaSchedulingRepository } from '../../infrastructure/adapters/prisma/PrismaSchedulingRepository';
import { StageNotFoundError } from '../../domain/errors/scheduling';
import { prisma } from '../../infrastructure/database/prisma';

// Cast mocked prisma for test usage
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

afterEach(() => {
  jest.resetAllMocks();
});

// ─── WARNING 4: moveTaskToStage must distinguish STAGE_NOT_FOUND from TASK_NOT_FOUND ─

describe('PrismaSchedulingRepository.moveTaskToStage — WARNING 4', () => {
  it('throws StageNotFoundError when stageId does not exist in DB', async () => {
    // stage.findUnique returns null → stage not found
    (mockPrisma.stage.findUnique as jest.Mock).mockResolvedValue(null);

    const repo = new PrismaSchedulingRepository();
    await expect(repo.moveTaskToStage('task-1', 'non-existent-stage-id')).rejects.toBeInstanceOf(StageNotFoundError);
  });

  it('returns null (task not found) when stageId exists but task update fails', async () => {
    // stage found, but task update throws (task doesn't exist)
    (mockPrisma.stage.findUnique as jest.Mock).mockResolvedValue({ id: 'stage-1', category: 'nuevo', name: 'Nuevo' });
    (mockPrisma.scheduledTask.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.scheduledTask.update as jest.Mock).mockRejectedValue(new Error('Record not found'));

    const repo = new PrismaSchedulingRepository();
    const result = await repo.moveTaskToStage('non-existent-task', 'stage-1');
    expect(result).toBeNull();
  });
});
