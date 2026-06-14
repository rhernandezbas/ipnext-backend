import { randomUUID } from 'crypto';
import { IClassStatusCatalogEntry } from '@domain/entities/iclass-status-catalog';
import {
  IClassStatusCatalogRepository,
  UpsertStatusInput,
  UpdateStatusInput,
} from '@domain/ports/IClassStatusCatalogRepository';

export class InMemoryIClassStatusCatalogRepository implements IClassStatusCatalogRepository {
  private rows = new Map<string, IClassStatusCatalogEntry>();

  async list(): Promise<IClassStatusCatalogEntry[]> {
    return [...this.rows.values()]
      .map(r => ({ ...r }))
      .sort((a, b) => a.statusCode.localeCompare(b.statusCode));
  }

  async getByStatusCode(statusCode: string): Promise<IClassStatusCatalogEntry | null> {
    const row = [...this.rows.values()].find(r => r.statusCode === statusCode);
    return row ? { ...row } : null;
  }

  async upsertByStatusCode(input: UpsertStatusInput): Promise<{ status: 'created' | 'updated' }> {
    const existing = [...this.rows.values()].find(r => r.statusCode === input.statusCode);
    if (existing) {
      // Refresh iclassLabel and lastSyncedAt; PRESERVE operator-configured fields.
      existing.iclassLabel = input.iclassLabel;
      existing.lastSyncedAt = new Date();
      existing.updatedAt = new Date();
      return { status: 'updated' };
    }
    const now = new Date();
    const entry: IClassStatusCatalogEntry = {
      id: randomUUID(),
      statusCode: input.statusCode,
      iclassLabel: input.iclassLabel,
      displayLabel: null,
      color: null,
      tracked: false,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(entry.id, entry);
    return { status: 'created' };
  }

  async update(statusCode: string, patch: UpdateStatusInput): Promise<IClassStatusCatalogEntry | null> {
    const existing = [...this.rows.values()].find(r => r.statusCode === statusCode);
    if (!existing) return null;

    if ('displayLabel' in patch) existing.displayLabel = patch.displayLabel ?? null;
    if ('color' in patch) existing.color = patch.color ?? null;
    if ('tracked' in patch && patch.tracked !== undefined) existing.tracked = patch.tracked;

    existing.updatedAt = new Date();
    return { ...existing };
  }

  async findManyByStatusCodes(codes: string[]): Promise<IClassStatusCatalogEntry[]> {
    if (!codes.length) return [];
    const set = new Set(codes);
    return [...this.rows.values()]
      .filter(r => set.has(r.statusCode))
      .map(r => ({ ...r }));
  }
}
