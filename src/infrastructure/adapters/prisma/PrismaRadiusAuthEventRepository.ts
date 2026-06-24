import { RadiusAuthEvent, RadiusAuthReply } from '@domain/entities/radius-auth-event';
import {
  RadiusAuthEventRepository,
  RadiusAuthEventFilters,
  RadiusAuthEventUpsert,
  PaginatedResult,
} from '@domain/ports/RadiusAuthEventRepository';
import { prisma } from '../../database/prisma';

/**
 * PrismaRadiusAuthEventRepository — adapter de persistencia para RadiusAuthEvent.
 *
 * - `upsertMany`: upsert atómico por `sourceUniqueId` (ON CONFLICT → update). Un postauth no muta,
 *   pero el upsert garantiza idempotencia ante re-ingest del mismo evento.
 * - `list`: filtra + pagina, orden authdate DESC.
 * - `deleteOlderThan`: DELETE WHERE authdate < cutoff en lotes (indexed).
 *
 * ⚠️  El client Prisma es el singleton global. Usamos `(prisma as any).radiusAuthEvent`
 *     para sortear el no-regen local (patrón del proyecto, igual que PrismaRadiusEventRepository).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function model(): any {
  return (prisma as any).radiusAuthEvent;
}

export class PrismaRadiusAuthEventRepository implements RadiusAuthEventRepository {
  async upsertMany(rows: RadiusAuthEventUpsert[]): Promise<number> {
    if (rows.length === 0) return 0;

    // $transaction: todos los upserts son atómicos. Si uno falla, rollback total.
    await (prisma as any).$transaction(
      rows.map((row) =>
        model().upsert({
          where: { sourceUniqueId: row.sourceUniqueId },
          create: {
            sourceUniqueId: row.sourceUniqueId,
            username:       row.username,
            reply:          row.reply,
            authdate:       row.authdate,
            class:          row.class,
          },
          update: {
            // Un evento de auth es inmutable; solo class podría llegar resuelto en un tick posterior.
            class: row.class,
          },
        }),
      ),
    );

    return rows.length;
  }

  async list(filters: RadiusAuthEventFilters): Promise<PaginatedResult<RadiusAuthEvent>> {
    const where = buildWhere(filters);
    const skip  = (filters.page - 1) * filters.pageSize;

    const [rows, total] = await Promise.all([
      model().findMany({
        where,
        orderBy: [{ authdate: 'desc' }, { sourceUniqueId: 'asc' }],
        skip,
        take: filters.pageSize,
      }),
      model().count({ where }),
    ]);

    return {
      data:     (rows as unknown[]).map(toEntity),
      total,
      page:     filters.page,
      pageSize: filters.pageSize,
    };
  }

  async deleteOlderThan(cutoff: Date, batchSize: number): Promise<number> {
    let totalDeleted = 0;

    while (true) {
      const rows = await model().findMany({
        where:  { authdate: { lt: cutoff } },
        select: { id: true },
        take:   batchSize,
      });

      if (rows.length === 0) break;

      const ids = (rows as Array<{ id: string }>).map((r) => r.id);
      const { count } = await model().deleteMany({ where: { id: { in: ids } } });
      totalDeleted += count;

      if (rows.length < batchSize) break;
    }

    return totalDeleted;
  }
}

// ── Mappers ─────────────────────────────────────────────────────────────────

function buildWhere(filters: RadiusAuthEventFilters): Record<string, unknown> {
  const where: Record<string, unknown> = {};

  if (filters.username !== undefined) where['username'] = filters.username;
  if (filters.reply    !== undefined) where['reply']    = filters.reply;

  if (filters.from !== undefined || filters.to !== undefined) {
    const authdate: Record<string, unknown> = {};
    if (filters.from !== undefined) authdate['gte'] = filters.from;
    if (filters.to   !== undefined) authdate['lte'] = filters.to;
    where['authdate'] = authdate;
  }

  return where;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEntity(row: any): RadiusAuthEvent {
  return {
    id:             row.id,
    sourceUniqueId: row.sourceUniqueId,
    username:       row.username,
    reply:          row.reply as RadiusAuthReply,
    authdate:       row.authdate instanceof Date ? row.authdate.toISOString() : String(row.authdate),
    class:          row.class ?? null,
    createdAt:      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt:      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}
