/**
 * TDD — wave-1a (cierre atómico first-writer-wins) — `closeTaskIfOpen`.
 *
 * HOY hay CUATRO escritores independientes de generalStatus='closed', ninguno
 * atómico (todos hacen getTask → check en memoria → updateTask, con un TOCTOU real
 * entre el read y el write). `closeTaskIfOpen` es el único chokepoint nuevo:
 * en Prisma, una sola sentencia `updateMany({ where: { id, generalStatus: { not:
 * 'closed' } } })` toma el row lock; acá, en memoria, el `beforeCloseWrite` hook
 * simula esa ventana de carrera para que el test la ejercite de verdad (sin el
 * hook, JS de un solo hilo nunca produciría una carrera real — ver el comentario
 * del hook más abajo).
 */
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';

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

describe('InMemorySchedulingRepository.closeTaskIfOpen', () => {
  it('two concurrent closers (app vs iclass) — exactly one wins, the other sees the winner', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await repo.createTask(CREATE_INPUT);

    // The hook fires INSIDE the race window (after each caller has already decided
    // "I'm about to write", before either actually writes) — this is what forces a
    // genuine interleave in single-threaded JS. Both calls suspend here; when they
    // resume, they resume in call order (Promise.all evaluates closeApp() first).
    let releases: Array<() => void> = [];
    repo.setBeforeCloseWriteHook(() => new Promise<void>(resolve => releases.push(resolve)));

    const closeApp = repo.closeTaskIfOpen(task.id, { origin: 'app', resultCode: 'INSTALACION_OK' });
    const closeIclass = repo.closeTaskIfOpen(task.id, { origin: 'iclass', resultCode: 'REAGENDADO' });

    // Let both calls reach the hook before releasing either.
    await Promise.resolve();
    await Promise.resolve();
    expect(releases).toHaveLength(2);
    releases.forEach(r => r());

    const [resultApp, resultIclass] = await Promise.all([closeApp, closeIclass]);

    const results = [resultApp, resultIclass];
    const winners = results.filter(r => r.closed === true);
    const losers = results.filter(r => r.closed === false);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // The loser reports the winner's origin/resultCode — never its own.
    const winnerInput = winners[0] === resultApp
      ? { origin: 'app', resultCode: 'INSTALACION_OK' }
      : { origin: 'iclass', resultCode: 'REAGENDADO' };
    expect(losers[0]!.existingOrigin).toBe(winnerInput.origin);
    expect(losers[0]!.existingResultCode).toBe(winnerInput.resultCode);

    // Final persisted state matches the winner — never silently overwritten by the loser.
    const finalTask = await repo.getTask(task.id);
    expect(finalTask!.generalStatus).toBe('closed');
    expect(finalTask!.closureOrigin).toBe(winnerInput.origin);
  });

  it('closing an already-closed task is a no-op: closed=false, existingOrigin of the previous winner, no double write', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await repo.createTask(CREATE_INPUT);

    const first = await repo.closeTaskIfOpen(task.id, { origin: 'staff', resultCode: 'INSTALACION_OK', closedByUserId: 'u-1' });
    expect(first.closed).toBe(true);

    const second = await repo.closeTaskIfOpen(task.id, { origin: 'iclass', resultCode: 'REAGENDADO' });

    expect(second.closed).toBe(false);
    expect(second.existingOrigin).toBe('staff');
    expect(second.existingResultCode).toBe('INSTALACION_OK');

    // The second (losing) call never touched the persisted origin.
    const finalTask = await repo.getTask(task.id);
    expect(finalTask!.closureOrigin).toBe('staff');
  });

  it('returns closed=false with nulls for a task that does not exist', async () => {
    const repo = new InMemorySchedulingRepository();

    const result = await repo.closeTaskIfOpen('does-not-exist', { origin: 'staff' });

    expect(result.closed).toBe(false);
    expect(result.task).toBeNull();
    expect(result.existingOrigin).toBeNull();
    expect(result.existingResultCode).toBeNull();
  });

  it('winner writes generalStatus=closed, isClosed=true and closureOrigin in the SAME operation', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await repo.createTask(CREATE_INPUT);

    const result = await repo.closeTaskIfOpen(task.id, { origin: 'staff', resultCode: null });

    expect(result.closed).toBe(true);
    expect(result.task!.generalStatus).toBe('closed');
    expect(result.task!.isClosed).toBe(true);
    expect(result.task!.closureOrigin).toBe('staff');
  });
});
