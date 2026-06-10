import type { UispDeviceRepository } from '@domain/ports/UispDeviceRepository';
import type { UispDevice } from '@domain/entities/uisp';

/**
 * In-memory UispDeviceRepository for tests.
 * Stores devices by uispId as the upsert key.
 */
export class InMemoryUispDeviceRepository implements UispDeviceRepository {
  private _store = new Map<string, UispDevice>();

  async upsert(device: UispDevice): Promise<void> {
    this._store.set(device.uispId, { ...device });
  }

  async listAll(): Promise<UispDevice[]> {
    return [...this._store.values()];
  }

  async listBySiteId(uispSiteId: string): Promise<UispDevice[]> {
    return [...this._store.values()].filter(d => d.uispSiteId === uispSiteId);
  }

  async findByUispId(uispId: string): Promise<UispDevice | null> {
    return this._store.get(uispId) ?? null;
  }

  async markMissing(uispIds: string[], since: Date): Promise<void> {
    for (const uispId of uispIds) {
      const existing = this._store.get(uispId);
      if (existing && existing.missingSince === null) {
        this._store.set(uispId, { ...existing, missingSince: since });
      }
    }
  }

  async clearMissing(uispIds: string[]): Promise<void> {
    for (const uispId of uispIds) {
      const existing = this._store.get(uispId);
      if (existing) {
        this._store.set(uispId, { ...existing, missingSince: null });
      }
    }
  }

  /** Test seam: directly seed a device without going through upsert. */
  seed(device: UispDevice): void {
    this._store.set(device.uispId, { ...device });
  }

  get size(): number {
    return this._store.size;
  }
}
