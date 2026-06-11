import {
  GigaredConfig,
  GigaredConfigRepository,
} from '@domain/ports/GigaredConfigRepository';
import { prisma } from '../../database/prisma';

/** The single config row is always keyed by this id (schema `@default("singleton")`). */
const SINGLETON_ID = 'singleton';

/** Hardcoded defaults returned before the singleton row exists (empty key = unconfigured). */
const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://partners.gigaredsa.com.ar/api/v1',
};

interface ConfigRow {
  apiKey: string;
  baseUrl: string;
  updatedAt: Date;
}

function toConfig(row: ConfigRow): GigaredConfig {
  return { apiKey: row.apiKey, baseUrl: row.baseUrl, updatedAt: row.updatedAt.toISOString() };
}

/**
 * Prisma adapter for the single-row Gigared config (#47). Uses `(prisma as any)` so it
 * keeps compiling before the client is regenerated for the new table.
 * `get()` returns defaults when the singleton row is absent; `update()` upserts.
 */
export class PrismaGigaredConfigRepository implements GigaredConfigRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).gigaredConfig;
  }

  async get(): Promise<GigaredConfig> {
    const row: ConfigRow | null = await this.table.findUnique({ where: { id: SINGLETON_ID } });
    return row
      ? toConfig(row)
      : { apiKey: DEFAULTS.apiKey, baseUrl: DEFAULTS.baseUrl, updatedAt: new Date(0).toISOString() };
  }

  async update(patch: Partial<Pick<GigaredConfig, 'apiKey' | 'baseUrl'>>): Promise<GigaredConfig> {
    const data: { apiKey?: string; baseUrl?: string } = {};
    if (patch.apiKey !== undefined) data.apiKey = patch.apiKey;
    if (patch.baseUrl !== undefined) data.baseUrl = patch.baseUrl;

    const row: ConfigRow = await this.table.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        apiKey: data.apiKey ?? DEFAULTS.apiKey,
        baseUrl: data.baseUrl ?? DEFAULTS.baseUrl,
      },
      update: data,
    });
    return toConfig(row);
  }
}
