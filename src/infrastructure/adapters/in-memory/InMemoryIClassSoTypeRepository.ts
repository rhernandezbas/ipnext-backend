import { randomUUID } from 'crypto';
import { IClassSoType } from '@domain/entities/iclass-so-type';
import { IClassSoTypeRepository, UpsertSoTypeInput } from '@domain/ports/IClassSoTypeRepository';

/**
 * In-memory implementation of IClassSoTypeRepository.
 * Backing store: Map<id, IClassSoType> + secondary index Map<code, id>.
 * Used in use-case tests and route tests (no DB required).
 */
export class InMemoryIClassSoTypeRepository implements IClassSoTypeRepository {
  private readonly byId: Map<string, IClassSoType> = new Map();
  /** Secondary index: code → id */
  private readonly codeIndex: Map<string, string> = new Map();

  async list(filter?: { active?: boolean }): Promise<IClassSoType[]> {
    const all = Array.from(this.byId.values());
    if (filter?.active === undefined) return all.map(e => ({ ...e }));
    return all.filter(e => e.active === filter.active).map(e => ({ ...e }));
  }

  async getById(id: string): Promise<IClassSoType | null> {
    const entry = this.byId.get(id);
    return entry ? { ...entry } : null;
  }

  async getByCode(code: string): Promise<IClassSoType | null> {
    const id = this.codeIndex.get(code);
    if (!id) return null;
    const entry = this.byId.get(id);
    return entry ? { ...entry } : null;
  }

  async upsertMany(
    items: UpsertSoTypeInput[],
    now: Date,
  ): Promise<{ created: number; updated: number; reactivated: number }> {
    let created = 0;
    let updated = 0;
    let reactivated = 0;

    for (const item of items) {
      const existingId = this.codeIndex.get(item.code);
      if (existingId) {
        const existing = this.byId.get(existingId)!;
        const wasInactive = !existing.active;
        const updated_entry: IClassSoType = {
          ...existing,
          description: item.description,
          active: true,
          lastSyncedAt: now,
          updatedAt: now,
        };
        this.byId.set(existingId, updated_entry);
        if (wasInactive) {
          reactivated++;
        } else {
          updated++;
        }
      } else {
        const id = randomUUID();
        const entry: IClassSoType = {
          id,
          code: item.code,
          description: item.description,
          active: true,
          lastSyncedAt: now,
          createdAt: now,
          updatedAt: now,
        };
        this.byId.set(id, entry);
        this.codeIndex.set(item.code, id);
        created++;
      }
    }

    return { created, updated, reactivated };
  }

  async deactivateMissing(presentCodes: string[]): Promise<number> {
    const presentSet = new Set(presentCodes);
    let count = 0;
    for (const entry of this.byId.values()) {
      if (entry.active && !presentSet.has(entry.code)) {
        this.byId.set(entry.id, { ...entry, active: false, updatedAt: new Date() });
        count++;
      }
    }
    return count;
  }
}
