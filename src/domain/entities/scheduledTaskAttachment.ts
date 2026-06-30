/**
 * Foto/adjunto de una ScheduledTask (feature task-photos).
 *
 * El binario vive en el storage (port FileStorage / MinIO en prod) bajo `storageKey`;
 * esta entidad es la fila de metadatos que lo referencia. La GENERACIÓN de la key la
 * hace el use case (otra fase); acá sólo la guardamos. `width`/`height` son opcionales
 * (sólo cuando el use case logra leer las dimensiones de la imagen).
 */
export interface ScheduledTaskAttachment {
  id: string;
  taskId: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  uploadedById: string;
  createdAt: string; // ISO-8601
}

export interface CreateScheduledTaskAttachmentInput {
  id: string;
  taskId: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  uploadedById: string;
  createdAt?: string;
}

/**
 * Factory para ScheduledTaskAttachment. Valida invariantes de negocio:
 * filename no vacío y sizeBytes > 0 (un adjunto de 0 bytes es basura).
 */
export function createScheduledTaskAttachment(
  input: CreateScheduledTaskAttachmentInput,
): ScheduledTaskAttachment {
  if (!input.filename || !input.filename.trim()) {
    throw new Error('Attachment filename is required');
  }
  if (!(input.sizeBytes > 0)) {
    throw new Error('Attachment sizeBytes must be greater than 0');
  }
  if (!input.uploadedById || !input.uploadedById.trim()) {
    throw new Error('Attachment uploadedById is required');
  }
  return {
    id: input.id,
    taskId: input.taskId,
    storageKey: input.storageKey,
    filename: input.filename.trim(),
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    width: input.width ?? null,
    height: input.height ?? null,
    uploadedById: input.uploadedById,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
