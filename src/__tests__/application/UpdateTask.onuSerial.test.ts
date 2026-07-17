/**
 * K3 (fiber-auto-watcher) — UpdateTask persiste onuSerial NORMALIZADO
 * (UPPERCASE, sin espacios) y lo expone en la tarea devuelta (DTO del FE).
 *
 * La normalización vive en el USE CASE (no solo en el Zod de la ruta): cualquier
 * caller interno que pase un serial "sucio" persiste igual el canónico — el
 * watcher matchea contra ese valor y un serial con espacios jamás matchearía.
 */
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { EntityLookup } from '@domain/ports/EntityLookup';

const ACTOR = { actorId: 'u1', actorName: 'Alice' };

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

function makeUseCase(repo: InMemorySchedulingRepository) {
  const any = new AnyLookup();
  return new UpdateTask(repo, any, any, any, any, any);
}

describe('UpdateTask — onuSerial (K3 fiber-auto-watcher)', () => {
  it('persiste el serial y lo devuelve en la tarea (contrato del DTO para el FE)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1' });
    const uc = makeUseCase(repo);

    const updated = await uc.execute('task-1', { onuSerial: 'HWTC11112222' }, ACTOR);

    expect(updated!.onuSerial).toBe('HWTC11112222');
    const fetched = await repo.getTask('task-1');
    expect(fetched!.onuSerial).toBe('HWTC11112222');
  });

  it('NORMALIZA al persistir: minúsculas + espacios → UPPERCASE sin espacios', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1' });
    const uc = makeUseCase(repo);

    const updated = await uc.execute('task-1', { onuSerial: ' hwtc 1111 2222 ' }, ACTOR);

    expect(updated!.onuSerial).toBe('HWTC11112222');
  });

  it('null LIMPIA el serial existente', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', onuSerial: 'HWTC11112222' });
    const uc = makeUseCase(repo);

    const updated = await uc.execute('task-1', { onuSerial: null }, ACTOR);

    expect(updated!.onuSerial).toBeNull();
  });

  it('update SIN onuSerial en el body NO toca el serial existente', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', onuSerial: 'HWTC11112222' });
    const uc = makeUseCase(repo);

    const updated = await uc.execute('task-1', { title: 'otro título' }, ACTOR);

    expect(updated!.onuSerial).toBe('HWTC11112222');
  });

  it('string SOLO espacios → normaliza a vacío → persiste null (equivale a limpiar)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', onuSerial: 'HWTC11112222' });
    const uc = makeUseCase(repo);

    const updated = await uc.execute('task-1', { onuSerial: '   ' }, ACTOR);

    expect(updated!.onuSerial).toBeNull();
  });

  it('las tareas nacen sin serial (default null en el DTO)', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await repo.getTask('1'); // fixture seedeada
    expect(task!.onuSerial).toBeNull();
  });
});
