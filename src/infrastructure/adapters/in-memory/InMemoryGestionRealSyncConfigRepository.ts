import {
  GestionRealSyncConfigRepository,
  SyncConfig,
} from '@domain/ports/GestionRealSyncConfigRepository';

/** Hardcoded defaults returned before any row is persisted (REQ-CFG-1). */
const DEFAULTS: SyncConfig = {
  intervalMs: 180000,
  estados: ['1', '2', '3', '4', '6'],
};

/**
 * In-memory implementation of the single-row client-sync config. Mirrors the
 * Prisma adapter's contract: `get()` returns defaults until something is
 * persisted, `update()` merges a partial patch and returns the resulting full
 * config. `estados` is REPLACED wholesale (never merged).
 */
export class InMemoryGestionRealSyncConfigRepository implements GestionRealSyncConfigRepository {
  private config: SyncConfig | null = null;

  async get(): Promise<SyncConfig> {
    const current = this.config ?? DEFAULTS;
    return { intervalMs: current.intervalMs, estados: [...current.estados] };
  }

  async update(patch: Partial<SyncConfig>): Promise<SyncConfig> {
    const current = this.config ?? DEFAULTS;
    this.config = {
      intervalMs: patch.intervalMs ?? current.intervalMs,
      // estados replaces wholesale when present; untouched otherwise.
      estados: patch.estados !== undefined ? [...patch.estados] : [...current.estados],
    };
    return { intervalMs: this.config.intervalMs, estados: [...this.config.estados] };
  }
}
