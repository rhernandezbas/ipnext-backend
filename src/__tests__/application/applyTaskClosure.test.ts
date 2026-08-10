/**
 * TDD — wave-1a (cierre atómico) — applyTaskClosure.
 *
 * The SINGLE application-layer helper that wraps `closeTaskIfOpen` for all 5
 * writers. Its ENTIRE job here (W1a.8/9): call the atomic guard, and — ONLY when
 * this call lost the race AND the loser's resultCode DIFFERS from the winner's —
 * log `[task-closure-conflict]` and emit a `closure_conflict` ScheduledTaskActivity.
 * A duplicate close with the SAME resultCode is idempotency, not a discrepancy:
 * neither the log nor the activity fire.
 */
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { applyTaskClosure } from '@application/use-cases/applyTaskClosure';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';

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

describe('applyTaskClosure', () => {
  it('winner (closed=true) — no log, no closure_conflict activity', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeTaskActivityRecorder();
    const task = await repo.createTask(CREATE_INPUT);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await applyTaskClosure(repo, recorder, {
      taskId: task.id,
      origin: 'app',
      resultCode: 'INSTALACION_OK',
    });

    expect(result.closed).toBe(true);
    expect(recorder.calls.filter(c => c.type === 'closure_conflict')).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('task-closure-conflict'));
    logSpy.mockRestore();
  });

  it('loser with a DIFFERENT resultCode — logs [task-closure-conflict] + emits closure_conflict activity with both values', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeTaskActivityRecorder();
    const task = await repo.createTask(CREATE_INPUT);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    // 't-1' closed by app with 'INSTALACION_OK' first (the winner)...
    await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'app', resultCode: 'INSTALACION_OK' });
    recorder.calls.length = 0; // isolate the assertions to the SECOND call

    // ...then iclass brings a DIFFERENT result for the same task (the loser).
    const result = await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'iclass', resultCode: 'REAGENDADO' });

    expect(result.closed).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[task-closure-conflict]'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`task=${task.id}`));

    const conflictEvents = recorder.calls.filter(c => c.type === 'closure_conflict');
    expect(conflictEvents).toHaveLength(1);
    expect(conflictEvents[0]!.taskId).toBe(task.id);
    expect(conflictEvents[0]!.payload.metadata).toEqual({
      winnerOrigin: 'app',
      winnerResultCode: 'INSTALACION_OK',
      loserOrigin: 'iclass',
      loserResultCode: 'REAGENDADO',
    });

    logSpy.mockRestore();
  });

  it('loser with the SAME resultCode — idempotent duplicate: no log, no activity', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeTaskActivityRecorder();
    const task = await repo.createTask(CREATE_INPUT);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'app', resultCode: 'INSTALACION_OK' });
    recorder.calls.length = 0;
    logSpy.mockClear();

    const result = await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'iclass', resultCode: 'INSTALACION_OK' });

    expect(result.closed).toBe(false);
    expect(recorder.calls.filter(c => c.type === 'closure_conflict')).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it('works without a recorder (optional collaborator) — still logs, never throws', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await repo.createTask(CREATE_INPUT);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await applyTaskClosure(repo, undefined, { taskId: task.id, origin: 'app', resultCode: 'A' });
    const result = await applyTaskClosure(repo, undefined, { taskId: task.id, origin: 'iclass', resultCode: 'B' });

    expect(result.closed).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[task-closure-conflict]'));

    logSpy.mockRestore();
  });
});
