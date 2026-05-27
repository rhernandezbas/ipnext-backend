/**
 * TDD — SetTaskInventoryReview use case
 * RED first: use case does not exist yet.
 */

import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { SetTaskInventoryReview } from '../../application/use-cases/SetTaskInventoryReview';
import { TaskNotFoundError } from '../../domain/errors/scheduling';

const CREATE_INPUT = {
  title: 'Tarea de prueba',
  description: null,
  stageId: '10000000-0000-4000-a000-000000000001',
  priority: 'normal',
  estimatedHours: 1,
  address: null,
  coordinates: null,
  category: 'other',
  completedAt: null,
  notes: null,
  startDate: null,
  endDate: null,
  customerId: null,
  serviceId: null,
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  travelTimeTo: null,
  travelTimeFrom: null,
};

describe('SetTaskInventoryReview use case', () => {
  it('sets reviewedByInventory to true', async () => {
    const repo = new InMemorySchedulingRepository();
    const useCase = new SetTaskInventoryReview(repo);

    const task = await repo.createTask(CREATE_INPUT);
    expect(task.reviewedByInventory).toBe(false);

    const updated = await useCase.execute(task.id, true);
    expect(updated.reviewedByInventory).toBe(true);
  });

  it('unsets reviewedByInventory to false', async () => {
    const repo = new InMemorySchedulingRepository();
    const useCase = new SetTaskInventoryReview(repo);

    const task = await repo.createTask(CREATE_INPUT);
    await useCase.execute(task.id, true);
    const reopened = await useCase.execute(task.id, false);
    expect(reopened.reviewedByInventory).toBe(false);
  });

  it('throws TaskNotFoundError when task does not exist', async () => {
    const repo = new InMemorySchedulingRepository();
    const useCase = new SetTaskInventoryReview(repo);

    await expect(useCase.execute('nonexistent-id', true)).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('does not affect other task fields', async () => {
    const repo = new InMemorySchedulingRepository();
    const useCase = new SetTaskInventoryReview(repo);

    const task = await repo.createTask({ ...CREATE_INPUT, title: 'Keep this title' });
    const updated = await useCase.execute(task.id, true);

    expect(updated.title).toBe('Keep this title');
    expect(updated.isClosed).toBe(false);
    expect(updated.priority).toBe('normal');
  });
});
