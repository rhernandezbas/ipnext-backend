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
import { PushIClassClosureOnTaskEnd } from '../../application/use-cases/PushIClassClosureOnTaskEnd';
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';

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

/** The IClass push is fire-and-forget: let its microtasks run before asserting. */
async function flushPush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
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

  // wave-1a (cierre atómico) — closing routes through closeTaskIfOpen(origin='staff').
  it('wave-1a: closing an open task routes through the atomic guard with origin=staff', async () => {
    const repo = new InMemorySchedulingRepository();
    const useCase = new SetTaskGeneralStatus(repo);
    const task = await repo.createTask(CREATE_INPUT);

    const updated = await useCase.execute(task.id, 'closed', { actorId: 'u-1', actorName: 'Ana' });

    expect(updated.closureOrigin).toBe('staff');
  });

  // wave-1a — the preexisting staff↔iclass race is closed by the SAME guard: if this
  // call loses (someone else closed it between the D8 read and the atomic write), it
  // must return the CURRENT (already-closed) task without throwing and without
  // emitting its own status_changed — the winner already emitted its own event.
  it('wave-1a: loses a race to a concurrent iclass close — returns the winner\'s task, no throw, no status_changed for THIS call', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeRecorder();
    const useCase = new SetTaskGeneralStatus(repo, recorder);
    const task = await repo.createTask(CREATE_INPUT);

    // Simulate: between this use case's D8 read (task still 'open') and its atomic
    // write, iclass wins the race and closes the task first.
    repo.setBeforeCloseWriteHook(async () => {
      repo.setBeforeCloseWriteHook(undefined);
      await repo.closeTaskIfOpen(task.id, { origin: 'iclass', resultCode: 'REAGENDADO' });
    });

    const result = await useCase.execute(task.id, 'closed', { actorId: 'u-1', actorName: 'Ana' });

    expect(result.generalStatus).toBe('closed');
    expect(result.closureOrigin).toBe('iclass');
    expect(recorder.events.filter(e => e.type === 'status_changed')).toHaveLength(0);
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

describe('SetTaskGeneralStatus — push to IClass on task end (PushIClassClosureOnTaskEnd)', () => {
  const ORDER_CODE = 'OS-300';

  function makeIClassSetup() {
    const iclass = new InMemoryIClassClient();
    const flagRepo = new InMemoryFeatureFlagRepository();
    flagRepo.seed('iclass-close-action', true);
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'i1', iclassCodigo: ORDER_CODE, statusCode: '1', statusDescription: 'Aberta' });
    const iclassClosurePush = new PushIClassClosureOnTaskEnd(iclass, flagRepo);
    return { iclass, flagRepo, iclassClosurePush };
  }

  it("transition open → closed WINS the race → pushes IClass closure with the task as it was BEFORE the change", async () => {
    const repo = new InMemorySchedulingRepository();
    const { iclass, iclassClosurePush } = makeIClassSetup();
    const useCase = new SetTaskGeneralStatus(repo, undefined, iclassClosurePush);
    const task = await repo.createTask(CREATE_INPUT);
    await repo.setIClassOrderCode(task.id, ORDER_CODE);

    await useCase.execute(task.id, 'closed', { actorId: 'u-1', actorName: 'Ana' });

    await flushPush();
    const calls = iclass.getCloseCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.serviceOrderCode).toBe(ORDER_CODE);
    expect(calls[0]!.commentary).toBe('Tarea cerrada en Prominense por Ana');
  });

  it('transition open → closed, no actor → pushes with actorName "Sistema"', async () => {
    const repo = new InMemorySchedulingRepository();
    const { iclass, iclassClosurePush } = makeIClassSetup();
    const useCase = new SetTaskGeneralStatus(repo, undefined, iclassClosurePush);
    const task = await repo.createTask(CREATE_INPUT);
    await repo.setIClassOrderCode(task.id, ORDER_CODE);

    await useCase.execute(task.id, 'closed');

    await flushPush();
    expect(iclass.getCloseCalls()[0]!.commentary).toBe('Tarea cerrada en Prominense por Sistema');
  });

  it('transition open → dismissed → pushes IClass closure with CANCELADA', async () => {
    const repo = new InMemorySchedulingRepository();
    const { iclass, iclassClosurePush } = makeIClassSetup();
    const useCase = new SetTaskGeneralStatus(repo, undefined, iclassClosurePush);
    const task = await repo.createTask(CREATE_INPUT);
    await repo.setIClassOrderCode(task.id, ORDER_CODE);

    await useCase.execute(task.id, 'dismissed', { actorId: 'u-1', actorName: 'Ana' });

    await flushPush();
    const calls = iclass.getCloseCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.commentary).toBe('Tarea descartada en Prominense por Ana');
  });

  it('no-op transition (already open → open) does NOT push to IClass', async () => {
    const repo = new InMemorySchedulingRepository();
    const { iclass, iclassClosurePush } = makeIClassSetup();
    const useCase = new SetTaskGeneralStatus(repo, undefined, iclassClosurePush);
    const task = await repo.createTask(CREATE_INPUT);
    await repo.setIClassOrderCode(task.id, ORDER_CODE);

    await useCase.execute(task.id, 'open');

    await flushPush();
    expect(iclass.getCloseCalls()).toHaveLength(0);
  });

  it('reopen (closed → open) does NOT push a close to IClass', async () => {
    const repo = new InMemorySchedulingRepository();
    const { iclass, iclassClosurePush } = makeIClassSetup();
    const useCase = new SetTaskGeneralStatus(repo, undefined, iclassClosurePush);
    const task = await repo.createTask(CREATE_INPUT);
    await repo.setIClassOrderCode(task.id, ORDER_CODE);
    await useCase.execute(task.id, 'closed');
    iclass.getCloseCalls(); // drain not needed — closeCalls only grows, check length after next call

    await useCase.execute(task.id, 'open');

    await flushPush();
    expect(iclass.getCloseCalls()).toHaveLength(1); // only the earlier close, not a second push on reopen
  });

  it('loses the local race (a concurrent iclass close already won) → does NOT push again', async () => {
    const repo = new InMemorySchedulingRepository();
    const { iclass, iclassClosurePush } = makeIClassSetup();
    const useCase = new SetTaskGeneralStatus(repo, undefined, iclassClosurePush);
    const task = await repo.createTask(CREATE_INPUT);
    await repo.setIClassOrderCode(task.id, ORDER_CODE);

    repo.setBeforeCloseWriteHook(async () => {
      repo.setBeforeCloseWriteHook(undefined);
      await repo.closeTaskIfOpen(task.id, { origin: 'iclass', resultCode: 'REAGENDADO' });
    });

    await useCase.execute(task.id, 'closed', { actorId: 'u-1', actorName: 'Ana' });

    await flushPush();
    expect(iclass.getCloseCalls()).toHaveLength(0);
  });
});
