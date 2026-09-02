import type {
  ExternalBulkMessagingConfig,
  ExternalBulkMessagingConfigRepository,
  ExternalBulkMessagingConfigPatch,
} from '@domain/ports/ExternalBulkMessagingConfigRepository';
import { EXTERNAL_BULK_MESSAGING_CONFIG_DEFAULTS } from '@domain/ports/ExternalBulkMessagingConfigRepository';
import { prisma } from '../../database/prisma';

const SINGLETON_ID = 'singleton';

interface ConfigRow {
  id: string;
  maxPerRequest: number;
  maxPerDay: number;
  updatedAt: Date;
}

function toEntity(row: ConfigRow): ExternalBulkMessagingConfig {
  return {
    maxPerRequest: row.maxPerRequest,
    maxPerDay: row.maxPerDay,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * external-bulk-messaging (1.6) — molde EXACTO `PrismaFinanceReceiptSyncConfigRepository`.
 * `get()` SIN fila persistida devuelve los defaults en código, sin tocar `upsert`
 * (CONFIG-1 — la fila nace recién con el primer `set()`/`PUT`).
 */
export class PrismaExternalBulkMessagingConfigRepository implements ExternalBulkMessagingConfigRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).externalBulkMessagingConfig;
  }

  /**
   * fix wave F1 (finding F14) — la fila singleton se crea PEREZOSAMENTE en la
   * primera lectura. Antes, sin fila, se devolvían los defaults con un
   * `updatedAt: new Date()` FABRICADO: la card admin mostraba "actualizado
   * recién" sobre una config que nadie tocó nunca, y cada `GET` devolvía un
   * timestamp distinto — un campo que miente es peor que uno ausente, y el
   * wire (D12) no admite `null`. El `update: {}` del upsert es deliberado: si
   * otro request creó la fila en el medio, esta lectura NO le pisa el
   * `updatedAt`. Si el upsert falla (DB read-only, permisos), se degrada a los
   * defaults en vez de voltear un GET de lectura.
   */
  async get(): Promise<ExternalBulkMessagingConfig> {
    const row: ConfigRow | null = await this.table.findUnique({ where: { id: SINGLETON_ID } });
    if (row) return toEntity(row);
    try {
      const created: ConfigRow = await this.table.upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID, ...EXTERNAL_BULK_MESSAGING_CONFIG_DEFAULTS },
        update: {},
      });
      return toEntity(created);
    } catch {
      return { ...EXTERNAL_BULK_MESSAGING_CONFIG_DEFAULTS, updatedAt: new Date().toISOString() };
    }
  }

  async set(patch: ExternalBulkMessagingConfigPatch): Promise<ExternalBulkMessagingConfig> {
    const row: ConfigRow = await this.table.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, maxPerRequest: patch.maxPerRequest, maxPerDay: patch.maxPerDay },
      update: { maxPerRequest: patch.maxPerRequest, maxPerDay: patch.maxPerDay },
    });
    return toEntity(row);
  }
}
