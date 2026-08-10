/**
 * TDD — fix wave W1a / FIX-9(c)(d) — dos mutantes que la suite no mataba.
 *
 * (c) D8 — re-pedir el estado actual es un no-op de VERDAD. `SetTaskGeneralStatus` corta
 *     en seco cuando el estado pedido ya es el vigente (`prev.generalStatus === status`).
 *     Lo que el spec pide ("Idempotent no-op stays a no-op under the new guard") no es
 *     "devuelve 200": es "no se movió nada".
 *
 *     MEDIDO, no supuesto: para `status:'closed'` el short-circuit YA NO es el mecanismo
 *     que garantiza la idempotencia — el guard atómico lo hace solo (borrar el
 *     short-circuit y re-cerrar sigue dando `closed:false`, sin evento y sin tocar
 *     `closedAt`, porque además el perdedor con `resultCode` null no reporta conflicto,
 *     FIX-4a). El short-circuit SIGUE siendo load-bearing para los estados que NO pasan
 *     por el guard: `open → open` y `dismissed → dismissed` van por `updateTask` y, sin
 *     el corte, emitirían un `status_changed` de X a X. Por eso acá se pinean AMBOS: el
 *     resultado observable del re-cierre (spec) y el caso que realmente mata al mutante.
 *
 * (d) L3 — `UpdateTask` DEBE strippear `generalStatus`/`isClosed` de `restData` antes de
 *     mandarlo a `updateTask`. Si deja de hacerlo, el cierre se escribe DOS veces: una
 *     por el guard atómico (con su `closureOrigin`) y otra por el `updateTask` genérico
 *     (sin él) — y como el segundo write pisa al primero por el camino no-guardado,
 *     vuelve la race que toda la wave existe para cerrar. Además, sobre una carrera
 *     PERDIDA, el `updateTask` sin strip re-escribiría `generalStatus:'closed'` pisando
 *     al ganador.
 */
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { SetTaskGeneralStatus } from '@application/use-cases/SetTaskGeneralStatus';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { UpdateTaskInput } from '@domain/ports/SchedulingRepository';

const ACTOR = { actorId: 'u-1', actorName: 'Alice' };
const OTHER = { actorId: 'u-2', actorName: 'Bob' };

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

describe('FIX-9(c) — D8: re-cerrar no cambia el cierre del ganador', () => {
  it('segundo POST {status:closed} → mismo closureOrigin, mismo closedAt, mismo closedByUserId, sin eventos nuevos', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'open', isClosed: false });
    const recorder = new FakeTaskActivityRecorder();
    const uc = new SetTaskGeneralStatus(repo, recorder);

    const first = await uc.execute('t1', 'closed', ACTOR);
    const snapshot = repo.getClosureDetails('t1');
    expect(first.closureOrigin).toBe('staff');
    expect(snapshot).not.toBeNull(); // presencia antes que ausencia
    const eventsAfterFirst = recorder.allTypes.length;
    expect(eventsAfterFirst).toBe(1);

    // Otro operador reintenta el mismo cierre 200ms después.
    await new Promise(r => setTimeout(r, 5));
    const second = await uc.execute('t1', 'closed', OTHER);

    expect(second.generalStatus).toBe('closed');
    expect(second.closureOrigin).toBe('staff');
    // Lo importante: NADA se movió. Ni el timestamp ni el autor del cierre.
    expect(repo.getClosureDetails('t1')).toEqual(snapshot);
    expect(repo.getClosureDetails('t1')!.closedByUserId).toBe('u-1'); // no 'u-2'
    // Y no se emitió ni un status_changed nuevo ni un closure_conflict.
    expect(recorder.allTypes.length).toBe(eventsAfterFirst);
    expect(recorder.allTypes).not.toContain('closure_conflict');
  });

  it('re-cerrar una tarea que ganó IClASS tampoco reescribe el origen', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'open', isClosed: false });
    await repo.closeTaskIfOpen('t1', { origin: 'iclass', resultCode: 'INSTALACION_OK', closedByUserId: null });
    const snapshot = repo.getClosureDetails('t1');
    const recorder = new FakeTaskActivityRecorder();

    const result = await new SetTaskGeneralStatus(repo, recorder).execute('t1', 'closed', ACTOR);

    expect(result.closureOrigin).toBe('iclass');
    expect(repo.getClosureDetails('t1')).toEqual(snapshot);
    expect(recorder.allTypes).toHaveLength(0);
  });

  // ── el caso donde el short-circuit D8 SÍ es el único mecanismo ──────────────────
  it.each(['open', 'dismissed'] as const)(
    'pedir %s sobre una tarea que YA está en ese estado no emite status_changed (X → X)',
    async (status) => {
      const repo = new InMemorySchedulingRepository();
      repo.seedTask({ id: 't1', generalStatus: status, isClosed: false });
      const recorder = new FakeTaskActivityRecorder();

      const result = await new SetTaskGeneralStatus(repo, recorder).execute('t1', status, ACTOR);

      expect(result.generalStatus).toBe(status);
      // Sin el short-circuit esto pasa por updateTask y emite un status_changed de X a X:
      // ruido en el feed de la tarea que ningún otro test cazaba.
      expect(recorder.allTypes).toHaveLength(0);
    },
  );

  it('CONTRASTE: una transición REAL sí emite status_changed (el detector no es vacuo)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'open', isClosed: false });
    const recorder = new FakeTaskActivityRecorder();

    await new SetTaskGeneralStatus(repo, recorder).execute('t1', 'dismissed', ACTOR);

    expect(recorder.allTypes).toEqual(['status_changed']);
  });
});

describe('FIX-9(d) — UpdateTask strippea generalStatus/isClosed del restData', () => {
  it('el updateTask genérico NO recibe generalStatus ni isClosed (el cierre ya lo hizo el guard)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'open', isClosed: false });
    const seen: UpdateTaskInput[] = [];
    const spy = jest.spyOn(repo, 'updateTask').mockImplementation(async function (this: unknown, id: string, data: UpdateTaskInput) {
      seen.push(data);
      return InMemorySchedulingRepository.prototype.updateTask.call(repo, id, data);
    } as never);
    const any = new AnyLookup();

    await new UpdateTask(repo, any, any, any, any, any).execute('t1', { notes: 'x', generalStatus: 'closed' }, ACTOR);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ notes: 'x' });
    expect(Object.keys(seen[0]!)).not.toContain('generalStatus');
    expect(Object.keys(seen[0]!)).not.toContain('isClosed');
    spy.mockRestore();
  });

  it('la vía legacy isClosed:true también se strippea (se normaliza a generalStatus y se saca)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'open', isClosed: false });
    const seen: UpdateTaskInput[] = [];
    const spy = jest.spyOn(repo, 'updateTask').mockImplementation(async function (id: string, data: UpdateTaskInput) {
      seen.push(data);
      return InMemorySchedulingRepository.prototype.updateTask.call(repo, id, data);
    } as never);
    const any = new AnyLookup();

    await new UpdateTask(repo, any, any, any, any, any).execute('t1', { notes: 'x', isClosed: true }, ACTOR);

    expect(seen[0]).toEqual({ notes: 'x' });
    spy.mockRestore();
  });

  it('sobre una carrera PERDIDA, el updateTask del perdedor no reescribe el estado del ganador', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'open', isClosed: false });
    const any = new AnyLookup();
    let fired = false;
    repo.setBeforeCloseWriteHook(async () => {
      if (fired) return;
      fired = true;
      repo.setBeforeCloseWriteHook(undefined);
      await repo.closeTaskIfOpen('t1', { origin: 'iclass', resultCode: 'REAGENDADO' });
    });

    await new UpdateTask(repo, any, any, any, any, any).execute('t1', { notes: 'x', generalStatus: 'closed' }, ACTOR);

    const task = await repo.getTask('t1');
    expect(task!.closureOrigin).toBe('iclass');
    expect(repo.getClosureDetails('t1')!.resultCode).toBe('REAGENDADO');
  });
});
