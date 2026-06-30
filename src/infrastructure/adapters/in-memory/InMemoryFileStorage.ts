import { FileStorage, StoredFile } from '@domain/ports/FileStorage';

/**
 * Storage in-memory para tests. Mapea key → { buffer, mimeType }.
 * Round-trip, overwrite y delete idempotente sin tocar disco/red.
 */
export class InMemoryFileStorage implements FileStorage {
  readonly store = new Map<string, StoredFile>();

  async save(input: { key: string; buffer: Buffer; mimeType: string }): Promise<void> {
    this.store.set(input.key, { buffer: input.buffer, mimeType: input.mimeType });
  }

  async get(key: string): Promise<StoredFile | null> {
    return this.store.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
