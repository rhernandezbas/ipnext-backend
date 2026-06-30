import { TaskAttachmentRepository } from '@domain/ports/TaskAttachmentRepository';
import {
  ScheduledTaskAttachmentDto,
  toScheduledTaskAttachmentDto,
} from '@application/dto/taskAttachment.dto';

export interface ListTaskAttachmentsInput {
  taskId: string;
}

/**
 * Lista los adjuntos (fotos) de una tarea como DTOs (con fileUrl/thumbUrl, sin storageKey).
 */
export class ListTaskAttachments {
  constructor(private readonly attachments: TaskAttachmentRepository) {}

  async execute(input: ListTaskAttachmentsInput): Promise<ScheduledTaskAttachmentDto[]> {
    const rows = await this.attachments.findByTaskId(input.taskId);
    return rows.map(toScheduledTaskAttachmentDto);
  }
}
