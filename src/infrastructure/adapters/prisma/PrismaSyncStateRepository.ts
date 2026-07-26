import { SyncStateRepository, SyncState } from '@domain/ports/SyncStateRepository';
import { prisma } from '../../database/prisma';

export class PrismaSyncStateRepository implements SyncStateRepository {
  async get(entity: string): Promise<SyncState | null> {
    const row = await prisma.syncState.findUnique({ where: { entity } });
    if (!row) return null;
    return {
      entity: row.entity,
      cursor: row.cursor,
      lastRunAt: row.lastRunAt,
      lastResult: row.lastResult,
      itemsSynced: row.itemsSynced,
    };
  }

  async save(state: SyncState): Promise<void> {
    const data = {
      cursor: state.cursor,
      lastRunAt: state.lastRunAt,
      lastResult: state.lastResult,
      itemsSynced: state.itemsSynced,
    };
    await prisma.syncState.upsert({
      where: { entity: state.entity },
      create: { entity: state.entity, ...data },
      update: data,
    });
  }

  /**
   * fix-wave-2 R2 — TARGETED single-column `UPDATE ... SET lastRunAt = NULL`.
   * `updateMany` (not `update`) so a missing row is a silent no-op (0 rows
   * affected) instead of Prisma throwing "record not found" — `cursor`/
   * `lastResult`/`itemsSynced` are never read nor rewritten by this call.
   */
  async clearLastRunAt(entity: string): Promise<void> {
    await prisma.syncState.updateMany({ where: { entity }, data: { lastRunAt: null } });
  }

  /**
   * fix-wave-2 R6 — TARGETED update: `upsert`'s `update` branch only ever
   * SETs `cursor`/`lastResult` (Prisma never reads the row first), so
   * `lastRunAt`/`itemsSynced` are untouched no matter what a concurrent
   * tick's own `save()` does to them. The `create` branch only runs when no
   * row exists at all — nothing concurrent to race against in that case.
   */
  async rearmCursor(entity: string, cursor: string, lastResult: string): Promise<void> {
    await prisma.syncState.upsert({
      where: { entity },
      create: { entity, cursor, lastResult, lastRunAt: null, itemsSynced: 0 },
      update: { cursor, lastResult },
    });
  }
}
