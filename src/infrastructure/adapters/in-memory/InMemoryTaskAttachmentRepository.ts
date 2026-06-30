import { TaskAttachmentRepository } from '@domain/ports/TaskAttachmentRepository';
import { ScheduledTaskAttachment } from '@domain/entities/scheduledTaskAttachment';

/**
 * Store in-memory de adjuntos de tarea (tests del port TaskAttachmentRepository).
 */
export class InMemoryTaskAttachmentRepository implements TaskAttachmentRepository {
  readonly store = new Map<string, ScheduledTaskAttachment>();

  async create(attachment: ScheduledTaskAttachment): Promise<ScheduledTaskAttachment> {
    this.store.set(attachment.id, { ...attachment });
    return { ...attachment };
  }

  async findByTaskId(taskId: string): Promise<ScheduledTaskAttachment[]> {
    return Array.from(this.store.values())
      .filter((a) => a.taskId === taskId)
      .map((a) => ({ ...a }));
  }

  async findById(id: string): Promise<ScheduledTaskAttachment | null> {
    const a = this.store.get(id);
    return a ? { ...a } : null;
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async countByTaskId(taskId: string): Promise<number> {
    return Array.from(this.store.values()).filter((a) => a.taskId === taskId).length;
  }
}
