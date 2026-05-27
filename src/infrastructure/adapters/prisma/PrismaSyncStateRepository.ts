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
}
