import {
  NocBroadcastConfig,
  NocBroadcastConfigRepository,
  NOC_BROADCAST_DEFAULTS,
} from '@domain/ports/NocBroadcastConfigRepository';

/**
 * N1 (noc-broadcast) — in-memory single-row config. Mirrors the Prisma adapter's
 * contract: `get()` returns defaults until something is persisted; `update()`
 * merges a partial patch (present keys win, omitted keys preserved) and returns
 * the resulting full config.
 */
export class InMemoryNocBroadcastConfigRepository implements NocBroadcastConfigRepository {
  private config: NocBroadcastConfig | null = null;

  async get(): Promise<NocBroadcastConfig> {
    return { ...(this.config ?? NOC_BROADCAST_DEFAULTS) };
  }

  async update(patch: Partial<NocBroadcastConfig>): Promise<NocBroadcastConfig> {
    const current = this.config ?? NOC_BROADCAST_DEFAULTS;
    this.config = {
      // `??` preserves an omitted key (undefined); an explicit '' or `false` is a
      // real value and wins (matches the Prisma adapter's `!== undefined` build).
      enabled: patch.enabled ?? current.enabled,
      evolutionBaseUrl: patch.evolutionBaseUrl ?? current.evolutionBaseUrl,
      evolutionApiKey: patch.evolutionApiKey ?? current.evolutionApiKey,
      evolutionInstance: patch.evolutionInstance ?? current.evolutionInstance,
      targetChat: patch.targetChat ?? current.targetChat,
      appPublicUrl: patch.appPublicUrl ?? current.appPublicUrl,
    };
    return { ...this.config };
  }
}
