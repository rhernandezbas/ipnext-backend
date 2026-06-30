/**
 * Port de almacenamiento de archivos binarios (fotos de tareas).
 *
 * Abstrae el storage concreto (MinIO en prod, in-memory en tests) detrás del patrón
 * BE-proxy: el BE guarda/sirve por `key`, el storage real queda privado. La generación
 * de la key es responsabilidad del use case; acá el storage sólo persiste por key.
 */
export interface StoredFile {
  buffer: Buffer;
  mimeType: string;
}

export interface FileStorage {
  save(input: { key: string; buffer: Buffer; mimeType: string }): Promise<void>;
  /** Devuelve null si la key no existe. */
  get(key: string): Promise<StoredFile | null>;
  /** Idempotente: borrar una key inexistente no es error. */
  delete(key: string): Promise<void>;
}
