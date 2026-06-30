import { ScheduledTaskAttachment } from '@domain/entities/scheduledTaskAttachment';

/**
 * Repositorio de adjuntos (fotos) de una ScheduledTask.
 *
 * `countByTaskId` existe para que el use case aplique el límite de adjuntos por tarea
 * (15) sin tener que materializar todas las filas.
 */
export interface TaskAttachmentRepository {
  create(attachment: ScheduledTaskAttachment): Promise<ScheduledTaskAttachment>;
  findByTaskId(taskId: string): Promise<ScheduledTaskAttachment[]>;
  findById(id: string): Promise<ScheduledTaskAttachment | null>;
  delete(id: string): Promise<void>;
  countByTaskId(taskId: string): Promise<number>;
}
