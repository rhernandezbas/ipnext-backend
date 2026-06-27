import { randomUUID } from 'crypto';
import { RadiusAuthEvent } from '@domain/entities/radius-auth-event';
import {
  RadiusAuthEventRepository,
  RadiusAuthEventFilters,
  RadiusAuthBaseFilters,
  RadiusAuthEventUpsert,
  PaginatedResult,
} from '@domain/ports/RadiusAuthEventRepository';

/**
 * InMemoryRadiusAuthEventRepository — test seam para RadiusAuthEventRepository.
 *
 * - upsertMany es idempotente por `sourceUniqueId` (Map-backed).
 * - list aplica todos los filtros de RadiusAuthEventFilters y ordena authdate DESC.
 * - deleteOlderThan elimina por authdate < cutoff (retención).
 */
export class InMemoryRadiusAuthEventRepository implements RadiusAuthEventRepository {
  /** Map sourceUniqueId → RadiusAuthEvent */
  private readonly store = new Map<string, RadiusAuthEvent>();

  async upsertMany(rows: RadiusAuthEventUpsert[]): Promise<number> {
    for (const row of rows) {
      const existing = this.store.get(row.sourceUniqueId);
      const event: RadiusAuthEvent = existing
        ? {
            // ── UPDATE: identidad del evento de auth es inmutable; un postauth no muta. ──
            // El upsert preserva el registro; solo refrescamos updatedAt para fidelidad con Prisma.
            id:             existing.id,
            sourceUniqueId: existing.sourceUniqueId,
            username:       existing.username,
            reply:          existing.reply,
            authdate:       existing.authdate,
            class:          row.class,
            // reason congelado: el update NO lo pisa (espejo del Prisma, igual que authdate).
            reason:         existing.reason,
            createdAt:      existing.createdAt,
            updatedAt:      new Date().toISOString(),
          }
        : {
            id:             randomUUID(),
            sourceUniqueId: row.sourceUniqueId,
            username:       row.username,
            reply:          row.reply,
            authdate:       row.authdate.toISOString(),
            class:          row.class,
            // reason se guarda en el create (cerca del evento).
            reason:         row.reason,
            createdAt:      new Date().toISOString(),
            updatedAt:      new Date().toISOString(),
          };
      this.store.set(row.sourceUniqueId, event);
    }
    return rows.length;
  }

  async list(filters: RadiusAuthEventFilters): Promise<PaginatedResult<RadiusAuthEvent>> {
    let items = [...this.store.values()];

    if (filters.username !== undefined) {
      items = items.filter((e) => e.username === filters.username);
    }
    if (filters.reply !== undefined) {
      items = items.filter((e) => e.reply === filters.reply);
    }
    if (filters.reason !== undefined) {
      items = items.filter((e) => e.reason === filters.reason);
    }
    if (filters.from !== undefined) {
      const fromMs = filters.from.getTime();
      items = items.filter((e) => new Date(e.authdate).getTime() >= fromMs);
    }
    if (filters.to !== undefined) {
      const toMs = filters.to.getTime();
      items = items.filter((e) => new Date(e.authdate).getTime() <= toMs);
    }

    // Orden authdate DESC (lo más reciente primero), igual que el adapter Prisma.
    // El orden vive en el REPO para que la paginación cross-página sea correcta.
    items.sort((a, b) => {
      const cmp = b.authdate.localeCompare(a.authdate);
      return cmp !== 0 ? cmp : a.sourceUniqueId.localeCompare(b.sourceUniqueId);
    });

    const total = items.length;
    const { page, pageSize } = filters;
    const skip  = (page - 1) * pageSize;
    const data  = items.slice(skip, skip + pageSize).map((e) => ({ ...e }));

    return { data, total, page, pageSize };
  }

  async countByReason(filters: RadiusAuthBaseFilters): Promise<Record<string, number>> {
    let items = [...this.store.values()];

    // Aplica los filtros base (sin reason, sin paginación)
    if (filters.username !== undefined) {
      items = items.filter((e) => e.username === filters.username);
    }
    if (filters.reply !== undefined) {
      items = items.filter((e) => e.reply === filters.reply);
    }
    if (filters.from !== undefined) {
      const fromMs = filters.from.getTime();
      items = items.filter((e) => new Date(e.authdate).getTime() >= fromMs);
    }
    if (filters.to !== undefined) {
      const toMs = filters.to.getTime();
      items = items.filter((e) => new Date(e.authdate).getTime() <= toMs);
    }

    // Agrupa por reason (solo filas con reason NOT NULL)
    const counts: Record<string, number> = {};
    for (const item of items) {
      if (item.reason !== null) {
        counts[item.reason] = (counts[item.reason] ?? 0) + 1;
      }
    }
    return counts;
  }

  async deleteOlderThan(cutoff: Date, batchSize: number): Promise<number> {
    const cutoffMs = cutoff.getTime();
    let deleted = 0;

    for (const [key, event] of this.store.entries()) {
      if (deleted >= batchSize) break;
      if (new Date(event.authdate).getTime() < cutoffMs) {
        this.store.delete(key);
        deleted++;
      }
    }

    return deleted;
  }
}
