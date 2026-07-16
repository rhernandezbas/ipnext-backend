import type { AccessPoint } from '@domain/entities/accessPoint';
import type { AccessPointRepository, UpsertAccessPointInput } from '@domain/ports/AccessPointRepository';

/**
 * In-memory AccessPointRepository for tests.
 * Stores APs keyed by uispDeviceId (the upsert key). Never deletes.
 */
export class InMemoryAccessPointRepository implements AccessPointRepository {
  private _store = new Map<string, AccessPoint>();
  private _seq = 1;

  async upsertByUispDeviceId(input: UpsertAccessPointInput): Promise<AccessPoint> {
    const now = new Date();
    const existing = this._store.get(input.uispDeviceId);
    if (existing) {
      const updated: AccessPoint = {
        ...existing,
        name: input.name,
        mac: input.mac,
        networkSiteId: input.networkSiteId,
        updatedAt: now,
      };
      this._store.set(input.uispDeviceId, updated);
      return { ...updated };
    }
    const created: AccessPoint = {
      id: `ap-${this._seq++}`,
      uispDeviceId: input.uispDeviceId,
      networkSiteId: input.networkSiteId,
      name: input.name,
      mac: input.mac,
      missingSince: null,
      createdAt: now,
      updatedAt: now,
    };
    this._store.set(input.uispDeviceId, created);
    return { ...created };
  }

  async findMany(): Promise<AccessPoint[]> {
    return [...this._store.values()].map(ap => ({ ...ap }));
  }

  async findByNetworkSiteId(networkSiteId: string): Promise<AccessPoint[]> {
    return [...this._store.values()]
      .filter(ap => ap.networkSiteId === networkSiteId)
      .map(ap => ({ ...ap }));
  }

  async findById(id: string): Promise<AccessPoint | null> {
    const found = [...this._store.values()].find(ap => ap.id === id);
    return found ? { ...found } : null;
  }

  /** FIX-2: stamp missingSince only where currently null (preserves original date). */
  async markMissing(uispDeviceIds: string[], since: Date): Promise<void> {
    for (const id of uispDeviceIds) {
      const existing = this._store.get(id);
      if (existing && existing.missingSince === null) {
        this._store.set(id, { ...existing, missingSince: since });
      }
    }
  }

  /** FIX-2: clear missingSince on reappeared APs. */
  async clearMissing(uispDeviceIds: string[]): Promise<void> {
    for (const id of uispDeviceIds) {
      const existing = this._store.get(id);
      if (existing) {
        this._store.set(id, { ...existing, missingSince: null });
      }
    }
  }

  /** Test seam: seed an AP directly. */
  seed(ap: AccessPoint): void {
    this._store.set(ap.uispDeviceId, { ...ap });
  }

  get size(): number {
    return this._store.size;
  }
}
