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

  async upsertByCode(
    entry: UpsertSoTypeInput,
  ): Promise<{ status: 'created' | 'updated' | 'reactivated' }> {
    const now = new Date();
    const existingId = this.codeIndex.get(entry.code);

    if (existingId) {
      const existing = this.byId.get(existingId)!;
      const wasInactive = !existing.active;
      const updated_entry: IClassSoType = {
        ...existing,
        description: entry.description,
        active: true,
        lastSyncedAt: now,
        updatedAt: now,
      };
      this.byId.set(existingId, updated_entry);
      return { status: wasInactive ? 'reactivated' : 'updated' };
    }

    const id = randomUUID();
    const newEntry: IClassSoType = {
      id,
      code: entry.code,
      description: entry.description,
      active: true,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(id, newEntry);
    this.codeIndex.set(entry.code, id);
    return { status: 'created' };
  }

  async markInactiveExcept(presentCodes: string[]): Promise<number> {
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
