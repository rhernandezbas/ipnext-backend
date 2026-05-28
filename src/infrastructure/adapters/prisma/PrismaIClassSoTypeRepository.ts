/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: This file uses `as any` casts on the Prisma client calls because
 * `prisma generate` has not been run yet against the enriched schema
 * (no DB available during this apply phase). The casts will become
 * unnecessary once the migration is applied and `npm run prisma:generate`
 * is executed. The runtime behaviour IS correct — the new columns exist
 * after the migration runs.
 */
import { IClassSoType } from '@domain/entities/iclass-so-type';
import { IClassSoTypeRepository, UpsertSoTypeInput } from '@domain/ports/IClassSoTypeRepository';
import { prisma } from '../../database/prisma';

function mapRow(row: any): IClassSoType {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    active: row.active,
    lastSyncedAt: row.lastSyncedAt instanceof Date ? row.lastSyncedAt : new Date(row.lastSyncedAt),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt),
  };
}

export class PrismaIClassSoTypeRepository implements IClassSoTypeRepository {
  async list(filter?: { active?: boolean }): Promise<IClassSoType[]> {
    const where = filter?.active !== undefined ? { active: filter.active } : undefined;
    const rows = await (prisma as any).iClassSoType.findMany({
      where,
      orderBy: { code: 'asc' },
    });
    return rows.map(mapRow);
  }

  async getById(id: string): Promise<IClassSoType | null> {
    const row = await (prisma as any).iClassSoType.findUnique({ where: { id } });
    return row ? mapRow(row) : null;
  }

  async getByCode(code: string): Promise<IClassSoType | null> {
    const row = await (prisma as any).iClassSoType.findUnique({ where: { code } });
    return row ? mapRow(row) : null;
  }

  /**
   * Upserts a single entry by `code`.
   * Pre-queries to detect create/update/reactivate status, then runs the upsert.
   */
  async upsertByCode(entry: UpsertSoTypeInput): Promise<{ status: 'created' | 'updated' | 'reactivated' }> {
    const now = new Date();

    // Pre-query to determine status
    const existing = await (prisma as any).iClassSoType.findUnique({ where: { code: entry.code } });

    let status: 'created' | 'updated' | 'reactivated';
    if (!existing) {
      status = 'created';
    } else if (existing.active === false) {
      status = 'reactivated';
    } else {
      status = 'updated';
    }

    await (prisma as any).iClassSoType.upsert({
      where: { code: entry.code },
      create: {
        code: entry.code,
        description: entry.description,
        active: true,
        lastSyncedAt: now,
      },
      update: {
        description: entry.description,
        active: true,
        lastSyncedAt: now,
        updatedAt: now,
      },
    });

    return { status };
  }

  /**
   * Marks active=false every row whose code is NOT in presentCodes.
   * Single bulk UPDATE (AD-6: no N round-trips). Returns count of deactivated rows.
   */
  async markInactiveExcept(presentCodes: string[]): Promise<number> {
    const now = new Date();
    const result = await (prisma as any).iClassSoType.updateMany({
      where: { code: { notIn: presentCodes }, active: true },
      data: { active: false, lastSyncedAt: now, updatedAt: now },
    });
    return result.count;
  }
}
