import {
  NocBroadcastConfig,
  NocBroadcastConfigRepository,
  NOC_BROADCAST_DEFAULTS,
} from '@domain/ports/NocBroadcastConfigRepository';
import { prisma } from '../../database/prisma';

/** The single config row is always keyed by this id (schema `@default("singleton")`). */
const SINGLETON_ID = 'singleton';

interface ConfigRow {
  enabled: boolean;
  evolutionBaseUrl: string;
  evolutionApiKey: string;
  evolutionInstance: string;
  targetChat: string;
  appPublicUrl: string;
}

function toConfig(row: ConfigRow): NocBroadcastConfig {
  return {
    enabled: row.enabled,
    evolutionBaseUrl: row.evolutionBaseUrl,
    evolutionApiKey: row.evolutionApiKey,
    evolutionInstance: row.evolutionInstance,
    targetChat: row.targetChat,
    appPublicUrl: row.appPublicUrl,
  };
}

/**
 * N1 (noc-broadcast) — Prisma adapter for the single-row NOC broadcast config.
 * Uses the `(prisma as any)` accessor (molde `PrismaGestionRealIngestConfigRepository`)
 * so it compiles before the client is regenerated for the new table. `get()`
 * returns defaults when the singleton row is absent; `update()` upserts and
 * returns the resulting full config (present keys only).
 */
export class PrismaNocBroadcastConfigRepository implements NocBroadcastConfigRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).nocBroadcastConfig;
  }

  async get(): Promise<NocBroadcastConfig> {
    const row: ConfigRow | null = await this.table.findUnique({ where: { id: SINGLETON_ID } });
    return row ? toConfig(row) : { ...NOC_BROADCAST_DEFAULTS };
  }

  async update(patch: Partial<NocBroadcastConfig>): Promise<NocBroadcastConfig> {
    // Build only the fields explicitly present so omitted keys are untouched.
    const data: Partial<NocBroadcastConfig> = {};
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.evolutionBaseUrl !== undefined) data.evolutionBaseUrl = patch.evolutionBaseUrl;
    if (patch.evolutionApiKey !== undefined) data.evolutionApiKey = patch.evolutionApiKey;
    if (patch.evolutionInstance !== undefined) data.evolutionInstance = patch.evolutionInstance;
    if (patch.targetChat !== undefined) data.targetChat = patch.targetChat;
    if (patch.appPublicUrl !== undefined) data.appPublicUrl = patch.appPublicUrl;

    const row: ConfigRow = await this.table.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...NOC_BROADCAST_DEFAULTS, ...data },
      update: data,
    });
    return toConfig(row);
  }
}
