import { randomUUID } from 'crypto';
import { IClassResultCode } from '@domain/entities/iclass-result-code';
import {
  IClassResultCodeRepository,
  UpsertResultCodeInput,
} from '@domain/ports/IClassResultCodeRepository';
import { normalizeResultCode } from '@application/use-cases/normalizeResultCode';

export class InMemoryIClassResultCodeRepository implements IClassResultCodeRepository {
  private rows = new Map<string, IClassResultCode>();
  /** Optional test seed: stageId → name, so assignStage can resolve mappedStageName. */
  private stageNames = new Map<string, string>();

  /** Test helper mirroring the Prisma JOIN: register a stage's display name. */
  seedStageName(stageId: string, name: string): void {
    this.stageNames.set(stageId, name);
  }

  /** Test helper (EPIC #38 W4): flag a result code as a removal code by name. */
  setRemovalCode(code: string, isRemovalCode: boolean): void {
    const norm = code.trim().toLowerCase();
    for (const r of this.rows.values()) {
      if (r.code.trim().toLowerCase() === norm) r.isRemovalCode = isRemovalCode;
    }
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
    // IClass varies the casing/whitespace of motivoFechamento vs the operator's
    // catalog, so match case-insensitively + trimmed (mirrors the Prisma adapter).
    const norm = code.trim().toLowerCase();
    for (const r of this.rows.values()) {
      if (r.code.trim().toLowerCase() === norm) return { ...r };
    }
    return null;
  }

  async findBySoTypeAndCode(soTypeId: string, code: string): Promise<IClassResultCode | null> {
    const norm = code.trim().toLowerCase();
    for (const r of this.rows.values()) {
      if (String(r.soTypeId) === soTypeId && r.code.trim().toLowerCase() === norm) return { ...r };
    }
    return null;
  }

  async findBySoTypeAndCodeNormalized(soTypeId: string, code: string): Promise<IClassResultCode | null> {
    const norm = normalizeResultCode(code);
    for (const r of this.rows.values()) {
      if (String(r.soTypeId) === soTypeId && normalizeResultCode(r.code) === norm) return { ...r };
    }
    return null;
  }

  async findByCodeNormalized(code: string): Promise<IClassResultCode | null> {
    const norm = normalizeResultCode(code);
    for (const r of this.rows.values()) {
      if (normalizeResultCode(r.code) === norm) return { ...r };
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
      isRemovalCode: false,
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
