/**
 * Unit tests for PrismaSchedulingRepository method behaviors
 * WARNING 1: updateTaskStatus throws StageNotFoundError when Default workflow stage is missing
 * WARNING 4: moveTaskToStage throws StageNotFoundError when target stageId doesn't exist
 */

// Mock the prisma singleton BEFORE importing anything that uses it
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    workflow: {
      findFirst: jest.fn(),
    },
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

// ─── WARNING 1: updateTaskStatus must throw StageNotFoundError (not write status) ─

describe('PrismaSchedulingRepository.updateTaskStatus — WARNING 1', () => {
  it('throws StageNotFoundError when Default workflow is not found', async () => {
    (mockPrisma.workflow.findFirst as jest.Mock).mockResolvedValue(null);

    const repo = new PrismaSchedulingRepository();
    await expect(repo.updateTaskStatus('task-1', 'pending')).rejects.toBeInstanceOf(StageNotFoundError);
  });

  it('throws StageNotFoundError when Default workflow has no matching stage', async () => {
    (mockPrisma.workflow.findFirst as jest.Mock).mockResolvedValue({
      id: 'wf-1',
      name: 'Default',
      stages: [
        // Only has 'En progreso' — no 'Nuevo' (simulating a corrupted/partial workflow)
        { id: 'stage-2', name: 'En progreso', category: 'enProgreso', order: 1 },
      ],
    });

    const repo = new PrismaSchedulingRepository();
    await expect(repo.updateTaskStatus('task-1', 'pending')).rejects.toBeInstanceOf(StageNotFoundError);
  });

  it('does NOT write status column directly — uses moveTaskToStage when stage found', async () => {
    (mockPrisma.workflow.findFirst as jest.Mock).mockResolvedValue({
      id: 'wf-1',
      name: 'Default',
      stages: [
        { id: 'stage-1', name: 'Nuevo', category: 'nuevo', order: 0 },
      ],
    });
    // moveTaskToStage needs stage.findUnique + task.findUnique + task.update
    (mockPrisma.stage.findUnique as jest.Mock).mockResolvedValue({ id: 'stage-1', category: 'nuevo', name: 'Nuevo' });
    (mockPrisma.scheduledTask.findUnique as jest.Mock).mockResolvedValue({ completedAt: null });
    (mockPrisma.scheduledTask.update as jest.Mock).mockResolvedValue({
      id: 'task-1',
      sequenceNumber: 1,
      title: 'Test',
      description: null,
      assignedTo: null,
      assignedToId: null,
      clientId: null,
      clientName: null,
      status: 'pending',
      priority: 'normal',
      scheduledDate: null,
      scheduledTime: null,
      estimatedHours: 1,
      address: null,
      lat: null,
      lng: null,
      category: 'installation',
      projectId: null,
      project: null,
      completedAt: null,
      notes: null,
      stageId: 'stage-1',
      stage: { id: 'stage-1', name: 'Nuevo', category: 'nuevo' },
    });

    const repo = new PrismaSchedulingRepository();
    const result = await repo.updateTaskStatus('task-1', 'pending');

    // Should succeed via moveTaskToStage, not direct status write
    expect(result).not.toBeNull();
    // Verify the update call was made with stageId, not with status directly
    const updateCall = (mockPrisma.scheduledTask.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.data).toHaveProperty('stageId');
    expect(updateCall.data).not.toHaveProperty('status');
  });
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
