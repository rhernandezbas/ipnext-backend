import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskAttachmentRepository } from '@domain/ports/TaskAttachmentRepository';
import { FileStorage } from '@domain/ports/FileStorage';
import { THUMB_KEY_SUFFIX, AttachmentLogger } from './AttachPhotosToTask';

/**
 * Borra una tarea Y limpia sus binarios del storage.
 *
 * El cascade de Postgres borra las FILAS de ScheduledTaskAttachment pero NO los
 * objetos del FileStorage (original + thumbnail) → quedarían HUÉRFANOS. Por eso
 * limpiamos el storage acá, de forma EAGER, ANTES de borrar la tarea.
 *
 * Orden crítico: objetos PRIMERO, tarea DESPUÉS. Si borráramos la tarea primero,
 * el cascade borraría las filas y perderíamos las storageKey.
 *
 * El borrado del storage es BEST-EFFORT: un fallo de MinIO (caído) se loguea y se
 * sigue — el borrado de la tarea NO debe quedar acoplado a que el storage esté arriba.
 *
 * `attachments` + `fileStorage` son colaboradores OPCIONALES (mismo patrón que
 * `recorder?`/`attempts?` en CreateTask/SendTaskToIClass): la composición de prod los
 * inyecta para limpiar el storage; los tests de routing que solo arman el router pueden
 * construir DeleteTask con el repo solo, sin la limpieza (no ejercitan adjuntos).
 */
export class DeleteTask {
  constructor(
    private readonly schedulingRepo: SchedulingRepository,
    private readonly attachments?: TaskAttachmentRepository,
    private readonly fileStorage?: FileStorage,
    private readonly logger: AttachmentLogger = console,
  ) {}

  async execute(id: string): Promise<boolean> {
    // 1) limpiar los binarios de cada adjunto ANTES de borrar la tarea (si están
    //    inyectados los colaboradores de storage).
    if (this.attachments && this.fileStorage) {
      const storage = this.fileStorage;
      const attachments = await this.attachments.findByTaskId(id);
      for (const att of attachments) {
        // Un try POR key: si falla el original, el thumbnail igual se intenta
        // (no queda huérfano) y viceversa.
        await this.deleteObject(storage, att.storageKey, id);
        await this.deleteObject(storage, `${att.storageKey}${THUMB_KEY_SUFFIX}`, id);
      }
    }

    // 2) borrar la tarea (el cascade borra las filas de adjuntos).
    return this.schedulingRepo.deleteTask(id);
  }

  /**
   * Borra UNA key del storage de forma BEST-EFFORT: un fallo se loguea (con la KEY que
   * efectivamente falló) y NO aborta el resto — ni el thumbnail ni el borrado de la tarea.
   */
  private async deleteObject(storage: FileStorage, key: string, taskId: string): Promise<void> {
    try {
      await storage.delete(key);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[DeleteTask] failed to delete storage object "${key}" for task ${taskId}: ${reason}`,
      );
    }
  }
}
