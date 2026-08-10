/**
 * TDD — fix wave W1a / FIX-3 — UpdateTask NO puede cerrar la tarea y después responder 404.
 *
 * El split-write que introdujo wave-1a hacía: `applyTaskClosure` PRIMERO y
 * `updateTask(restData)` DESPUÉS. Si el resto del patch fallaba (un `stageId`
 * inexistente: el adapter Prisma atrapa el error de FK y devuelve `null`), el use case
 * devolvía `null` → la ruta respondía 404 "no existe" … con la tarea YA CERRADA en la
 * base. El cliente reintenta, ve 409 / la ve cerrada, y nadie entiende por qué.
 *
 * El orden correcto es el inverso: primero el write que PUEDE fallar (y si falla la
 * tarea queda intacta y el error es honesto), y el cierre — atómico e irreversible —
 * AL FINAL.
 *
 * Nota: se usa una SUBCLASE del repo in-memory para simular "el write del resto falla",
 * no un mock de Prisma. El contrato del port es `updateTask → null` ante un write que
 * no se pudo aplicar; eso es lo que la subclase reproduce.
 */
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { UpdateTaskInput } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';

const ACTOR = { actorId: 'u1', actorName: 'Alice' };

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

/** Reproduce el contrato del adapter Prisma cuando el UPDATE revienta (FK inválida,
 * fila inexistente): `updateTask` devuelve null en vez de propagar. */
class FailingRestWriteRepository extends InMemorySchedulingRepository {
  public updateTaskCalls: Array<{ id: string; data: UpdateTaskInput }> = [];
  async updateTask(id: string, data: UpdateTaskInput): Promise<ScheduledTask | null> {
    this.updateTaskCalls.push({ id, data });
    return null; // el write del resto NO se aplicó
  }
}

function makeUseCase(repo: InMemorySchedulingRepository, recorder?: FakeTaskActivityRecorder) {
  const any = new AnyLookup();
  return new UpdateTask(repo, any, any, any, any, any, recorder);
}

describe('FIX-3 — UpdateTask: el write del resto va PRIMERO, el cierre AL FINAL', () => {
  it('(a) el write del resto falla + generalStatus=closed → devuelve null y la tarea NO queda cerrada', async () => {
    const repo = new FailingRestWriteRepository();
    repo.seedTask({ id: 'task-1', generalStatus: 'open', isClosed: false });
    const recorder = new FakeTaskActivityRecorder();
    const uc = makeUseCase(repo, recorder);

    const updated = await uc.execute('task-1', { stageId: 'stage-inexistente', generalStatus: 'closed' }, ACTOR);

    // Respuesta honesta: el patch no se aplicó.
    expect(updated).toBeNull();
    // Y — lo que importa — la tarea sigue ABIERTA. Antes del fix quedaba cerrada.
    const after = await repo.getTask('task-1');
    expect(after!.generalStatus).toBe('open');
    expect(after!.isClosed).toBe(false);
    expect(after!.closureOrigin).toBeNull();
    expect(repo.getClosureDetails('task-1')).toBeNull();
    // Nada que reportar: no hubo cierre, no hubo evento.
    expect(recorder.allTypes).toHaveLength(0);
  });

  it('(a-bis) el fallo del resto tampoco cierra cuando el patch viene por la vía legacy isClosed:true', async () => {
    const repo = new FailingRestWriteRepository();
    repo.seedTask({ id: 'task-1', generalStatus: 'open', isClosed: false });
    const uc = makeUseCase(repo);

    const updated = await uc.execute('task-1', { stageId: 'stage-inexistente', isClosed: true }, ACTOR);

    expect(updated).toBeNull();
    expect((await repo.getTask('task-1'))!.generalStatus).toBe('open');
  });

  it('(b) resto OK + cierre GANADO → 200 con la tarea cerrada, los campos del resto aplicados y status_changed', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', generalStatus: 'open', isClosed: false, notes: 'viejo' });
    const recorder = new FakeTaskActivityRecorder();
    const uc = makeUseCase(repo, recorder);

    const updated = await uc.execute('task-1', { notes: 'nuevo', generalStatus: 'closed' }, ACTOR);

    expect(updated!.notes).toBe('nuevo');
    expect(updated!.generalStatus).toBe('closed');
    expect(updated!.isClosed).toBe(true);
    expect(updated!.closureOrigin).toBe('staff');
    expect(repo.getClosureDetails('task-1')).toEqual({
      resultCode: null,
      closedByUserId: 'u1',
      closedAt: expect.any(String),
    });
    // El ganador SÍ emite status_changed (via el diff engine, con generalStatus en diffData).
    const types = recorder.allTypes;
    expect(types).toContain('status_changed');
    expect(types).toContain('notes_changed');
  });

  it('(c) resto OK + cierre PERDIDO → devuelve la tarea del ganador con el resto aplicado, sin status_changed del perdedor', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', generalStatus: 'open', isClosed: false, notes: 'viejo' });
    const recorder = new FakeTaskActivityRecorder();
    const uc = makeUseCase(repo, recorder);

    // iclass gana la carrera justo antes de que nuestro cierre escriba.
    let fired = false;
    repo.setBeforeCloseWriteHook(async () => {
      if (fired) return;
      fired = true;
      repo.setBeforeCloseWriteHook(undefined);
      await repo.closeTaskIfOpen('task-1', { origin: 'iclass', resultCode: 'REAGENDADO' });
    });

    const updated = await uc.execute('task-1', { notes: 'nuevo', generalStatus: 'closed' }, ACTOR);

    // El resto del patch se aplicó (fue PRIMERO) y el ganador conserva su cierre.
    expect(updated!.notes).toBe('nuevo');
    expect(updated!.generalStatus).toBe('closed');
    expect(updated!.closureOrigin).toBe('iclass');
    // El perdedor NO emite status_changed (generalStatus se strippea de diffData).
    expect(recorder.allTypes).not.toContain('status_changed');
    expect(recorder.allTypes).toContain('notes_changed');
  });

  it('(d) patch SOLO de cierre (sin campos rest) no llama a updateTask — el cierre atómico basta', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', generalStatus: 'open', isClosed: false });
    const spy = jest.spyOn(repo, 'updateTask');
    const uc = makeUseCase(repo);

    const updated = await uc.execute('task-1', { generalStatus: 'closed' }, ACTOR);

    expect(updated!.generalStatus).toBe('closed');
    expect(updated!.closureOrigin).toBe('staff');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('(e) tarea inexistente + generalStatus=closed → null, sin cerrar nada', async () => {
    const repo = new InMemorySchedulingRepository();
    const uc = makeUseCase(repo);

    const updated = await uc.execute('no-existe', { title: 'x', generalStatus: 'closed' }, ACTOR);

    expect(updated).toBeNull();
    expect(await repo.getTask('no-existe')).toBeNull();
  });
});
