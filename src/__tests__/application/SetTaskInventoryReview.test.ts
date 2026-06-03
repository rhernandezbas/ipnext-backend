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
  contractId: null,
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

  // F3 — actorId traceability
  it('sets reviewedByInventoryAt and resolves user name when actorId provided', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedRbacUserName('user-1', 'Carlos López');
    const useCase = new SetTaskInventoryReview(repo);

    const task = await repo.createTask(CREATE_INPUT);
    const before = new Date();
    const updated = await useCase.execute(task.id, true, 'user-1');

    expect(updated.reviewedByInventory).toBe(true);
    expect(updated.reviewedByInventoryAt).not.toBeNull();
    // reviewedByInventoryAt should be a valid ISO timestamp >= before
    expect(new Date(updated.reviewedByInventoryAt!).getTime()).toBeGreaterThanOrEqual(before.getTime());
    // In-memory resolves name from seeded map
    expect(updated.reviewedByInventoryUserName).toBe('Carlos López');
  });

  it('clears reviewedByInventoryAt and reviewedByInventoryUserName when unmarking', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedRbacUserName('user-1', 'Carlos López');
    const useCase = new SetTaskInventoryReview(repo);

    const task = await repo.createTask(CREATE_INPUT);
    await useCase.execute(task.id, true, 'user-1');
    const cleared = await useCase.execute(task.id, false, 'user-1');

    expect(cleared.reviewedByInventory).toBe(false);
    expect(cleared.reviewedByInventoryAt).toBeNull();
    expect(cleared.reviewedByInventoryUserName).toBeNull();
  });

  it('unknown task → TaskNotFoundError even with actorId', async () => {
    const repo = new InMemorySchedulingRepository();
    const useCase = new SetTaskInventoryReview(repo);

    await expect(useCase.execute('nonexistent-id', true, 'user-1')).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});
