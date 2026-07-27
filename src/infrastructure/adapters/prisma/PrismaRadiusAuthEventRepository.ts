import { RadiusAuthEvent, RadiusAuthReply } from '@domain/entities/radius-auth-event';
import {
  RadiusAuthEventRepository,
  RadiusAuthEventFilters,
  RadiusAuthBaseFilters,
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

/**
 * Tope de operaciones por `$transaction` (incidente 2026-07-26).
 *
 * Antes se mandaba la página ENTERA (hasta 500 upserts) en una sola transacción.
 * Cada upsert es un round-trip propio, así que con la DB lenta el lote se pasaba
 * del timeout de Prisma — medido en prod: **5245 ms contra 5000 ms**, fallaba por
 * 245 ms. Ese fallo disparaba el borrado del cursor en el scheduler y con él la
 * espiral que agotaba el heap de V8.
 *
 * Tradeoff ACEPTADO: se pierde la atomicidad "toda la página o nada". Es seguro
 * porque el upsert es idempotente por `sourceUniqueId` y, al preservarse ahora el
 * cursor ante un error, el próximo tick re-aplica los lotes ya escritos sin duplicar.
 */
export const UPSERT_CHUNK_SIZE = 100;

export class PrismaRadiusAuthEventRepository implements RadiusAuthEventRepository {
  async upsertMany(rows: RadiusAuthEventUpsert[]): Promise<number> {
    if (rows.length === 0) return 0;

    for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
      // $transaction por LOTE: los upserts del lote son atómicos entre sí.
      await (prisma as any).$transaction(
        chunk.map((row) =>
          model().upsert({
          where: { sourceUniqueId: row.sourceUniqueId },
          create: {
            sourceUniqueId: row.sourceUniqueId,
            username:       row.username,
            reply:          row.reply,
            authdate:       row.authdate,
            class:          row.class,
            // reason se congela en el create (cerca del evento). El update NO lo recomputa.
            reason:         row.reason,
          },
          update: {
            // Un evento de auth es inmutable; solo class podría llegar resuelto en un tick posterior.
            // reason NO se pisa: queda congelado al valor del primer ingest (igual que authdate).
            class: row.class,
          },
          }),
        ),
      );
    }

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

  async countByReason(filters: RadiusAuthBaseFilters): Promise<Record<string, number>> {
    const where = buildBaseWhere(filters);
    // groupBy reason, excluyendo filas con reason=null
    const groups = await model().groupBy({
      by: ['reason'],
      where: { ...where, reason: { not: null } },
      _count: { _all: true },
    });

    const result: Record<string, number> = {};
    for (const g of (groups as Array<{ reason: string | null; _count: { _all: number } }>)) {
      if (g.reason !== null) {
        result[g.reason] = g._count._all;
      }
    }
    return result;
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

/** Filtros base (username / reply / from / to) — usados tanto en `list` como en `countByReason`. */
function buildBaseWhere(filters: RadiusAuthBaseFilters): Record<string, unknown> {
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

/** Filtros completos para `list` (base + reason opcional). */
function buildWhere(filters: RadiusAuthEventFilters): Record<string, unknown> {
  const where = buildBaseWhere(filters);
  if (filters.reason !== undefined) where['reason'] = filters.reason;
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
    reason:         row.reason ?? null,
    createdAt:      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt:      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}
