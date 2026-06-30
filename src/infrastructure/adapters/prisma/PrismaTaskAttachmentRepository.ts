import { TaskAttachmentRepository } from '@domain/ports/TaskAttachmentRepository';
import { ScheduledTaskAttachment } from '@domain/entities/scheduledTaskAttachment';
import { prisma } from '../../database/prisma';

function toEntity(row: {
  id: string;
  taskId: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  uploadedById: string;
  createdAt: Date | string;
}): ScheduledTaskAttachment {
  return {
    id: row.id,
    taskId: row.taskId,
    storageKey: row.storageKey,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    width: row.width ?? null,
    height: row.height ?? null,
    uploadedById: row.uploadedById,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export class PrismaTaskAttachmentRepository implements TaskAttachmentRepository {
  async create(attachment: ScheduledTaskAttachment): Promise<ScheduledTaskAttachment> {
    const row = await prisma.scheduledTaskAttachment.create({
      data: {
        id: attachment.id,
        taskId: attachment.taskId,
        storageKey: attachment.storageKey,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        width: attachment.width,
        height: attachment.height,
        uploadedById: attachment.uploadedById,
      },
    });
    return toEntity(row);
  }

  async findByTaskId(taskId: string): Promise<ScheduledTaskAttachment[]> {
    const rows = await prisma.scheduledTaskAttachment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toEntity);
  }

  async findById(id: string): Promise<ScheduledTaskAttachment | null> {
    const row = await prisma.scheduledTaskAttachment.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async delete(id: string): Promise<void> {
    // Idempotente SOLO para "no existe" (Prisma P2025): lo absorbemos. Cualquier OTRO
    // error (conexión caída, deadlock, …) DEBE propagarse — nunca tragarse en silencio.
    try {
      await prisma.scheduledTaskAttachment.delete({ where: { id } });
    } catch (e) {
      if ((e as { code?: string } | null)?.code === 'P2025') return;
      throw e;
    }
  }

  async countByTaskId(taskId: string): Promise<number> {
    return prisma.scheduledTaskAttachment.count({ where: { taskId } });
  }
}
