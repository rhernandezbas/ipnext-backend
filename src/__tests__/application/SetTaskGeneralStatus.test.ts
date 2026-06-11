/**
 * TDD — #41 SetTaskGeneralStatus use case.
 * RED first: the use case does not exist yet.
 *
 * Covers: close / dismiss / reopen, 404 → TaskNotFoundError, invalid value →
 * InvalidGeneralStatusError, no-op (same status) emits no event (D8), and the
 * status_changed event carries STRING from/to values.
 */

import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { SetTaskGeneralStatus } from '../../application/use-cases/SetTaskGeneralStatus';
import { TaskNotFoundError, InvalidGeneralStatusError } from '../../domain/errors/scheduling';
import { TaskActivityRecorder, ActorContext } from '../../domain/ports/TaskActivityRecorder';
import { ActivityType } from '../../domain/entities/taskActivity';

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

interface RecordedEvent {
  taskId: string;
  type: ActivityType;
  actor: ActorContext;
  fromValue?: unknown;
  toValue?: unknown;
}

class FakeRecorder implements TaskActivityRecorder {
  events: RecordedEvent[] = [];
  async record(taskId: string, type: ActivityType, payload: { actor: ActorContext; fromValue?: unknown; toValue?: unknown }): Promise<void> {
    this.events.push({ taskId, type, actor: payload.actor, fromValue: payload.fromValue, toValue: payload.toValue });
  }
  async recordMany(): Promise<void> { /* unused here */ }
}

describe('SetTaskGeneralStatus use case', () => {
  it('closes an open task → generalStatus=closed, isClosed=true', async () => {
    const repo = new InMemorySchedulingRepository();
    const useCase = new SetTaskGeneralStatus(repo);
    const task = await repo.createTask(CREATE_INPUT);

    const updated = await useCase.execute(task.id, 'closed');

    expect(updated.generalStatus).toBe('closed');
    expect(updated.isClosed).toBe(true);
  });

  it('dismisses an open task → generalStatus=dismissed, isClosed=false', async () => {
    const repo = new InMemorySchedulingRepository();
    const useCase = new SetTaskGeneralStatus(repo);
    const task = await repo.createTask(CREATE_INPUT);

    const updated = await useCase.execute(task.id, 'dismissed');

    expect(updated.generalStatus).toBe('dismissed');
    expect(updated.isClosed).toBe(false);
  });

  it('reopens a dismissed task → generalStatus=open', async () => {
    const repo = new InMemorySchedulingRepository();
    const useCase = new SetTaskGeneralStatus(repo);
    const task = await repo.createTask(CREATE_INPUT);
    await useCase.execute(task.id, 'dismissed');

    const updated = await useCase.execute(task.id, 'open');

    expect(updated.generalStatus).toBe('open');
  });

  it('throws TaskNotFoundError for an unknown task', async () => {
    const repo = new InMemorySchedulingRepository();
    const useCase = new SetTaskGeneralStatus(repo);

    await expect(useCase.execute('nope', 'closed')).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('throws InvalidGeneralStatusError for an unknown status value', async () => {
    const repo = new InMemorySchedulingRepository();
    const useCase = new SetTaskGeneralStatus(repo);
    const task = await repo.createTask(CREATE_INPUT);

    await expect(useCase.execute(task.id, 'archived')).rejects.toBeInstanceOf(InvalidGeneralStatusError);
  });

  it('records a status_changed event with STRING from/to values', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeRecorder();
    const useCase = new SetTaskGeneralStatus(repo, recorder);
    const task = await repo.createTask(CREATE_INPUT);

    await useCase.execute(task.id, 'dismissed', { actorId: 'u-1', actorName: 'Ana' });

    expect(recorder.events).toHaveLength(1);
    const ev = recorder.events[0];
    expect(ev.type).toBe('status_changed');
    expect(ev.fromValue).toBe('open');
    expect(ev.toValue).toBe('dismissed');
    expect(ev.actor.actorId).toBe('u-1');
  });

  it('no-op when status is unchanged → no activity event (D8)', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeRecorder();
    const useCase = new SetTaskGeneralStatus(repo, recorder);
    const task = await repo.createTask(CREATE_INPUT); // already open

    const result = await useCase.execute(task.id, 'open');

    expect(result.generalStatus).toBe('open');
    expect(recorder.events).toHaveLength(0);
  });
});
