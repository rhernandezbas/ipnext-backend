import { DeleteTask } from '@application/use-cases/DeleteTask';
import { THUMB_KEY_SUFFIX } from '@application/use-cases/AttachPhotosToTask';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryTaskAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskAttachmentRepository';
import { createScheduledTaskAttachment, ScheduledTaskAttachment } from '@domain/entities/scheduledTaskAttachment';
import { FileStorage, StoredFile } from '@domain/ports/FileStorage';
import { TaskAttachmentRepository } from '@domain/ports/TaskAttachmentRepository';

/** FileStorage cuyo delete SIEMPRE falla (MinIO caído) — el resto delega in-memory. */
class FailingDeleteStorage implements FileStorage {
  private inner = new InMemoryFileStorage();
  get store() {
    return this.inner.store;
  }
  save(input: { key: string; buffer: Buffer; mimeType: string }): Promise<void> {
    return this.inner.save(input);
  }
  get(key: string): Promise<StoredFile | null> {
    return this.inner.get(key);
  }
  async delete(): Promise<void> {
    throw new Error('minio down');
  }
}

/** Siembra un attachment con su original + thumbnail en el storage. */
async function seedAttachment(
  attachments: InMemoryTaskAttachmentRepository,
  storage: FileStorage,
  opts: { id: string; taskId: string; storageKey: string },
): Promise<void> {
  await attachments.create(
    createScheduledTaskAttachment({
      id: opts.id,
      taskId: opts.taskId,
      storageKey: opts.storageKey,
      filename: `${opts.id}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      uploadedById: 'u1',
    }),
  );
  await storage.save({ key: opts.storageKey, buffer: Buffer.from('orig'), mimeType: 'image/jpeg' });
  await storage.save({
    key: `${opts.storageKey}${THUMB_KEY_SUFFIX}`,
    buffer: Buffer.from('thumb'),
    mimeType: 'image/jpeg',
  });
}

/**
 * TaskAttachmentRepository cuyo findByTaskId SIEMPRE lanza (DB caída). La lectura de
 * adjuntos es DB y parte del flujo: si revienta, execute DEBE abortar (no se traga el error).
 */
class ThrowingFindAttachmentRepository implements TaskAttachmentRepository {
  async create(a: ScheduledTaskAttachment): Promise<ScheduledTaskAttachment> {
    return a;
  }
  async findByTaskId(): Promise<ScheduledTaskAttachment[]> {
    throw new Error('db down');
  }
  async findById(): Promise<ScheduledTaskAttachment | null> {
    return null;
  }
  async delete(): Promise<void> {
    /* no-op */
  }
  async countByTaskId(): Promise<number> {
    return 0;
  }
}

describe('DeleteTask', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('happy path: borra original + thumbnail de CADA attachment del storage y luego la tarea', async () => {
    const scheduling = new InMemorySchedulingRepository();
    const attachments = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    scheduling.seedTask({ id: 'task-1' });

    const key1 = 'tasks/task-1/a.jpg';
    const key2 = 'tasks/task-1/b.jpg';
    await seedAttachment(attachments, storage, { id: 'a', taskId: 'task-1', storageKey: key1 });
    await seedAttachment(attachments, storage, { id: 'b', taskId: 'task-1', storageKey: key2 });
    // sanity: 4 objetos en storage antes de borrar (2 orig + 2 thumb)
    expect(storage.store.size).toBe(4);

    const uc = new DeleteTask(scheduling, attachments, storage);
    const result = await uc.execute('task-1');

    expect(result).toBe(true);
    // los 4 objetos binarios fueron borrados
    expect(await storage.get(key1)).toBeNull();
    expect(await storage.get(`${key1}${THUMB_KEY_SUFFIX}`)).toBeNull();
    expect(await storage.get(key2)).toBeNull();
    expect(await storage.get(`${key2}${THUMB_KEY_SUFFIX}`)).toBeNull();
    expect(storage.store.size).toBe(0);
    // la tarea ya no existe (segundo delete → false)
    expect(await scheduling.deleteTask('task-1')).toBe(false);
  });

  it('best-effort: si el storage está caído (delete siempre falla), igual borra la tarea y loguea warn', async () => {
    const scheduling = new InMemorySchedulingRepository();
    const attachments = new InMemoryTaskAttachmentRepository();
    const storage = new FailingDeleteStorage();
    const warn = jest.fn();
    scheduling.seedTask({ id: 'task-1' });
    await seedAttachment(attachments, storage, { id: 'a', taskId: 'task-1', storageKey: 'tasks/task-1/a.jpg' });

    const uc = new DeleteTask(scheduling, attachments, storage, { warn });
    const result = await uc.execute('task-1');

    // la tarea se borra pese al fallo de storage (no queda acoplada a MinIO)
    expect(result).toBe(true);
    expect(await scheduling.deleteTask('task-1')).toBe(false);
    // se logueó el warn con la key + el taskId
    expect(warn).toHaveBeenCalled();
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('tasks/task-1/a.jpg');
    expect(msg).toContain('task-1');
  });

  it('sin attachments: borra la tarea y NUNCA llama a fileStorage.delete', async () => {
    const scheduling = new InMemorySchedulingRepository();
    const attachments = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const deleteSpy = jest.spyOn(storage, 'delete');
    scheduling.seedTask({ id: 'task-1' });

    const uc = new DeleteTask(scheduling, attachments, storage);
    const result = await uc.execute('task-1');

    expect(result).toBe(true);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  // [ALTO 1] Invariante de ORDEN — FALSIFICABLE. El in-memory deleteTask solo hace
  // splice y NO modela el cascade, así que findByTaskId devuelve los objetos aunque
  // se invierta el orden. Para PROTEGER el invariante ("objetos ANTES de la tarea")
  // espiamos ambas operaciones y registramos su orden REAL de ejecución. Si en
  // DeleteTask.ts se moviera deleteTask(id) ANTES del loop de storage, el último
  // storage:* quedaría DESPUÉS de task-delete y este test FALLA.
  it('orden: borra TODOS los objetos del storage ANTES de borrar la tarea (invariante falsificable)', async () => {
    const scheduling = new InMemorySchedulingRepository();
    const attachments = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    scheduling.seedTask({ id: 'task-1' });

    const key1 = 'tasks/task-1/a.jpg';
    const key2 = 'tasks/task-1/b.jpg';
    await seedAttachment(attachments, storage, { id: 'a', taskId: 'task-1', storageKey: key1 });
    await seedAttachment(attachments, storage, { id: 'b', taskId: 'task-1', storageKey: key2 });

    const order: string[] = [];
    const realDelete = storage.delete.bind(storage);
    jest.spyOn(storage, 'delete').mockImplementation(async (key: string) => {
      order.push(`storage:${key}`);
      await realDelete(key);
    });
    const realDeleteTask = scheduling.deleteTask.bind(scheduling);
    jest.spyOn(scheduling, 'deleteTask').mockImplementation(async (id: string) => {
      order.push('task-delete');
      return realDeleteTask(id);
    });

    const uc = new DeleteTask(scheduling, attachments, storage);
    await uc.execute('task-1');

    const taskIdx = order.indexOf('task-delete');
    expect(taskIdx).toBeGreaterThanOrEqual(0);
    const storageIdxs = order
      .map((e, i) => (e.startsWith('storage:') ? i : -1))
      .filter((i) => i >= 0);
    // 4 objetos (2 orig + 2 thumb), y TODOS antes del task-delete
    expect(storageIdxs.length).toBe(4);
    expect(Math.max(...storageIdxs)).toBeLessThan(taskIdx);
  });

  // [MEDIO 2a] Tarea inexistente: findByTaskId → [] (loop no corre), deleteTask → false.
  it('tarea inexistente: no rompe, devuelve false y NUNCA llama a fileStorage.delete', async () => {
    const scheduling = new InMemorySchedulingRepository();
    const attachments = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const deleteSpy = jest.spyOn(storage, 'delete');

    const uc = new DeleteTask(scheduling, attachments, storage);
    const result = await uc.execute('ghost');

    expect(result).toBe(false);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  // [MEDIO 2b] findByTaskId lanza (DB error): la lectura de adjuntos es parte del flujo,
  // NO best-effort → execute RECHAZA y la tarea NO se borra. Comportamiento consciente.
  it('findByTaskId lanza (DB error): execute RECHAZA y no llega a borrar la tarea', async () => {
    const scheduling = new InMemorySchedulingRepository();
    const storage = new InMemoryFileStorage();
    const attachments = new ThrowingFindAttachmentRepository();
    scheduling.seedTask({ id: 'task-1' });
    const deleteTaskSpy = jest.spyOn(scheduling, 'deleteTask');

    const uc = new DeleteTask(scheduling, attachments, storage);

    await expect(uc.execute('task-1')).rejects.toThrow('db down');
    expect(deleteTaskSpy).not.toHaveBeenCalled();
  });

  // [BAJO 3] Un try por delete: si falla SOLO el original, el thumbnail igual se intenta
  // (no queda huérfano) y la tarea se borra. El warn reporta la KEY que efectivamente falló.
  it('best-effort por key: falla SOLO el original → el thumbnail igual se borra y la tarea también', async () => {
    const scheduling = new InMemorySchedulingRepository();
    const attachments = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const warn = jest.fn();
    scheduling.seedTask({ id: 'task-1' });

    const key = 'tasks/task-1/a.jpg';
    const thumbKey = `${key}${THUMB_KEY_SUFFIX}`;
    await seedAttachment(attachments, storage, { id: 'a', taskId: 'task-1', storageKey: key });

    const realDelete = storage.delete.bind(storage);
    const deleteSpy = jest.spyOn(storage, 'delete').mockImplementation(async (k: string) => {
      if (k === key) throw new Error('minio down on original');
      await realDelete(k);
    });

    const uc = new DeleteTask(scheduling, attachments, storage, { warn });
    const result = await uc.execute('task-1');

    expect(result).toBe(true);
    // el thumb se intentó borrar PESE al fallo del original (no se saltea)
    expect(deleteSpy).toHaveBeenCalledWith(thumbKey);
    expect(await storage.get(thumbKey)).toBeNull();
    // el warn reporta la KEY del original que falló (no otra)
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(key);
    // la tarea se borró
    expect(await scheduling.deleteTask('task-1')).toBe(false);
  });

  // [BAJO 4] El warn no asume Error: un reject con valor no-Error se loguea con String(err)
  // en vez de quedar "undefined" por `(err as Error).message`.
  it('warn robusto: reject con valor no-Error → no crashea y loguea su String()', async () => {
    const scheduling = new InMemorySchedulingRepository();
    const attachments = new InMemoryTaskAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const warn = jest.fn();
    scheduling.seedTask({ id: 'task-1' });

    const key = 'tasks/task-1/a.jpg';
    await seedAttachment(attachments, storage, { id: 'a', taskId: 'task-1', storageKey: key });

    jest.spyOn(storage, 'delete').mockImplementation(async () => {
      // reject con string (no-Error): `(err as Error).message` daría undefined
      return Promise.reject('minio exploded');
    });

    const uc = new DeleteTask(scheduling, attachments, storage, { warn });
    const result = await uc.execute('task-1');

    expect(result).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('minio exploded');
  });
});
