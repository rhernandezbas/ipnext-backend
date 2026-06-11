import { randomUUID } from 'crypto';
import { IClassNode } from '@domain/entities/iclass-node';
import { IClassNodeRepository, UpsertNodeInput } from '@domain/ports/IClassNodeRepository';

/**
 * In-memory implementation of IClassNodeRepository.
 * Backing store: Map<id, IClassNode> + secondary index Map<nodeId, id>.
 * Used in use-case tests and route tests (no DB required). Mirrors
 * InMemoryIClassSoTypeRepository, keyed by `nodeId` instead of `code`.
 */
export class InMemoryIClassNodeRepository implements IClassNodeRepository {
  private readonly byId: Map<string, IClassNode> = new Map();
  /** Secondary index: nodeId → id */
  private readonly nodeIdIndex: Map<number, string> = new Map();

  async list(filter?: { active?: boolean; selectable?: boolean }): Promise<IClassNode[]> {
    let all = Array.from(this.byId.values());
    if (filter?.active !== undefined) all = all.filter(e => e.active === filter.active);
    if (filter?.selectable !== undefined) all = all.filter(e => e.selectable === filter.selectable);
    return all.map(e => ({ ...e }));
  }

  async getById(id: string): Promise<IClassNode | null> {
    const entry = this.byId.get(id);
    return entry ? { ...entry } : null;
  }

  async upsertByNodeId(
    node: UpsertNodeInput,
  ): Promise<{ status: 'created' | 'updated' | 'reactivated' }> {
    const now = new Date();
    const existingId = this.nodeIdIndex.get(node.nodeId);

    if (existingId) {
      const existing = this.byId.get(existingId)!;
      const wasInactive = !existing.active;
      const updated: IClassNode = {
        ...existing,
        code: node.code,
        description: node.description,
        selectable: node.selectable,
        active: true,
        lastSyncedAt: now,
        updatedAt: now,
      };
      this.byId.set(existingId, updated);
      return { status: wasInactive ? 'reactivated' : 'updated' };
    }

    const id = randomUUID();
    const newEntry: IClassNode = {
      id,
      nodeId: node.nodeId,
      code: node.code,
      description: node.description,
      active: true,
      selectable: node.selectable,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(id, newEntry);
    this.nodeIdIndex.set(node.nodeId, id);
    return { status: 'created' };
  }

  async markInactiveExcept(presentNodeIds: number[]): Promise<number> {
    const presentSet = new Set(presentNodeIds);
    let count = 0;
    for (const entry of this.byId.values()) {
      if (entry.active && !presentSet.has(entry.nodeId)) {
        this.byId.set(entry.id, { ...entry, active: false, updatedAt: new Date() });
        count++;
      }
    }
    return count;
  }
}
