import type { UispSiteRepository } from '@domain/ports/UispSiteRepository';
import type { UispSite } from '@domain/entities/uisp';

/**
 * In-memory UispSiteRepository for tests.
 * Stores sites by uispId as the upsert key.
 */
export class InMemoryUispSiteRepository implements UispSiteRepository {
  private _store = new Map<string, UispSite>();

  async upsert(site: UispSite): Promise<void> {
    this._store.set(site.uispId, { ...site });
  }

  async listAll(): Promise<UispSite[]> {
    return [...this._store.values()];
  }

  async findByUispId(uispId: string): Promise<UispSite | null> {
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

  /** Test seam: directly seed a site without going through upsert. */
  seed(site: UispSite): void {
    this._store.set(site.uispId, { ...site });
  }

  get size(): number {
    return this._store.size;
  }
}
