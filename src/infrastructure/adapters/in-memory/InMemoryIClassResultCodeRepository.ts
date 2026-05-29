import { randomUUID } from 'crypto';
import { IClassResultCode } from '@domain/entities/iclass-result-code';
import {
  IClassResultCodeRepository,
  UpsertResultCodeInput,
} from '@domain/ports/IClassResultCodeRepository';

export class InMemoryIClassResultCodeRepository implements IClassResultCodeRepository {
  private rows = new Map<string, IClassResultCode>();
  /** Optional test seed: stageId → name, so assignStage can resolve mappedStageName. */
  private stageNames = new Map<string, string>();

  /** Test helper mirroring the Prisma JOIN: register a stage's display name. */
  seedStageName(stageId: string, name: string): void {
    this.stageNames.set(stageId, name);
  }

  async list(filter?: { mapped?: boolean }): Promise<IClassResultCode[]> {
    let items = [...this.rows.values()];
    if (filter?.mapped === true) items = items.filter(r => r.mappedStageId !== null);
    if (filter?.mapped === false) items = items.filter(r => r.mappedStageId === null);
    return items.map(r => ({ ...r }));
  }

  async getById(id: string): Promise<IClassResultCode | null> {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }

  async findByCode(code: string): Promise<IClassResultCode | null> {
    for (const r of this.rows.values()) {
      if (r.code === code) return { ...r };
    }
    return null;
  }

  async upsert(entry: UpsertResultCodeInput): Promise<{ status: 'created' | 'updated' }> {
    for (const r of this.rows.values()) {
      if (r.soTypeId === entry.soTypeId && r.code === entry.code) {
        // Update type + lastSyncedAt; PRESERVE the configured mapping.
        r.type = entry.type;
        r.lastSyncedAt = new Date();
        r.updatedAt = new Date();
        return { status: 'updated' };
      }
    }
    const now = new Date();
    const row: IClassResultCode = {
      id: randomUUID(),
      soTypeId: entry.soTypeId,
      code: entry.code,
      type: entry.type,
      mappedStageId: null,
      mappedStageName: null,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return { status: 'created' };
  }

  async assignStage(id: string, stageId: string | null): Promise<IClassResultCode | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    r.mappedStageId = stageId;
    r.mappedStageName = stageId !== null ? (this.stageNames.get(stageId) ?? null) : null;
    r.updatedAt = new Date();
    return { ...r };
  }
}
