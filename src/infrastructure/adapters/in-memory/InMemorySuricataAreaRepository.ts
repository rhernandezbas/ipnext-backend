import { randomUUID } from 'crypto';
import type { SuricataAreaRepository } from '@domain/ports/SuricataAreaRepository';
import type { SuricataAreaRecord, UpsertSuricataAreaInput } from '@domain/entities/suricata';

/** In-memory `SuricataAreaRepository` for use-case tests (D6.c, molde repo convention). */
export class InMemorySuricataAreaRepository implements SuricataAreaRepository {
  private rows: SuricataAreaRecord[] = [];

  async upsertMany(areas: UpsertSuricataAreaInput[]): Promise<SuricataAreaRecord[]> {
    return Promise.all(areas.map((a) => this.upsertOne(a)));
  }

  private async upsertOne(input: UpsertSuricataAreaInput): Promise<SuricataAreaRecord> {
    const existing = this.rows.find((r) => r.externalId === input.externalId);
    if (existing) {
      existing.name = input.name;
      existing.active = true;
      existing.syncedAt = input.syncedAt;
      return { ...existing };
    }
    const row: SuricataAreaRecord = {
      id: randomUUID(),
      externalId: input.externalId,
      name: input.name,
      active: true,
      syncedAt: input.syncedAt,
    };
    this.rows.push(row);
    return { ...row };
  }

  async deactivateMissing(seenExternalIds: string[]): Promise<void> {
    const seen = new Set(seenExternalIds);
    for (const row of this.rows) {
      if (!seen.has(row.externalId)) row.active = false;
    }
  }

  async list(): Promise<SuricataAreaRecord[]> {
    return this.rows.map((r) => ({ ...r }));
  }

  async findByExternalId(externalId: string): Promise<SuricataAreaRecord | null> {
    const row = this.rows.find((r) => r.externalId === externalId);
    return row ? { ...row } : null;
  }
}
