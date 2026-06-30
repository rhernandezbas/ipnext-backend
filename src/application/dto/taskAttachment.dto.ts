import { ScheduledTaskAttachment } from '@domain/entities/scheduledTaskAttachment';

/**
 * DTO de salida de un adjunto (foto) de tarea.
 *
 * NUNCA expone `storageKey` (es interna: la key del objeto en MinIO). En su lugar
 * publica `fileUrl`/`thumbUrl` = rutas relativas a los endpoints BE-proxy que
 * sirven el binario. El FE consume estas URLs; el storage real queda privado.
 */
export interface ScheduledTaskAttachmentDto {
  id: string;
  taskId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  uploadedById: string;
  createdAt: string;
  /** Ruta al binario original (BE-proxy). */
  fileUrl: string;
  /** Ruta al thumbnail (BE-proxy). Cae al original si la foto es vieja y no tiene thumb. */
  thumbUrl: string;
}

/** Base de los endpoints de file (alineada con taskAttachments.routes montado en /api/scheduling). */
const ATTACHMENTS_FILE_BASE = '/api/scheduling/attachments';

export function toScheduledTaskAttachmentDto(
  a: ScheduledTaskAttachment,
): ScheduledTaskAttachmentDto {
  return {
    id: a.id,
    taskId: a.taskId,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    width: a.width,
    height: a.height,
    uploadedById: a.uploadedById,
    createdAt: a.createdAt,
    fileUrl: `${ATTACHMENTS_FILE_BASE}/${a.id}/file`,
    thumbUrl: `${ATTACHMENTS_FILE_BASE}/${a.id}/file?variant=thumb`,
  };
}
