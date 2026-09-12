import type { SuricataAreaRepository } from '@domain/ports/SuricataAreaRepository';
import type { SuricataAreaRecord, UpsertSuricataAreaInput } from '@domain/entities/suricata';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value instanceof Date ? value.toISOString() : (value as string);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): SuricataAreaRecord {
  return {
    id: row.id,
    externalId: row.externalId,
    name: row.name,
    active: row.active,
    syncedAt: toIso(row.syncedAt),
  };
}

/**
 * suricata-tickets-mirror (Phase C, task C.5, D6.c) — Prisma adapter for
 * `SuricataAreaRepository`. Use cases test against `InMemorySuricataAreaRepository`
 * (repo convention: never mock Prisma); this adapter is verified by `tsc`
 * field-for-field parity with the in-memory twin, no local DB in this repo
 * (molde `WORKFLOW-MULTI-REPO.md`).
 */
export class PrismaSuricataAreaRepository implements SuricataAreaRepository {
  async upsertMany(areas: UpsertSuricataAreaInput[]): Promise<SuricataAreaRecord[]> {
    const rows = [];
    for (const input of areas) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).suricataArea.upsert({
        where: { externalId: input.externalId },
        create: {
          externalId: input.externalId,
          name: input.name,
          active: true,
          syncedAt: input.syncedAt,
        },
        update: {
          name: input.name,
          active: true,
          syncedAt: input.syncedAt,
        },
      });
      rows.push(toDomain(row));
    }
    return rows;
  }

  async deactivateMissing(seenExternalIds: string[]): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).suricataArea.updateMany({
      where: { externalId: { notIn: seenExternalIds }, active: true },
      data: { active: false },
    });
  }

  async list(): Promise<SuricataAreaRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).suricataArea.findMany();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }

  async findByExternalId(externalId: string): Promise<SuricataAreaRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataArea.findUnique({ where: { externalId } });
    return row ? toDomain(row) : null;
  }
}
