import {
  GestionRealIngestConfigRepository,
  IngestConfig,
} from '@domain/ports/GestionRealIngestConfigRepository';

/** Hardcoded defaults returned before any row is persisted (REQ-CFG-1). */
const DEFAULTS: IngestConfig = {
  intervalMs: 180000,
  windowMonths: 12,
  fiberProjectId: null,
  wirelessProjectId: null,
};

/**
 * In-memory implementation of the single-row ingest config. Mirrors the Prisma
 * adapter's contract: `get()` returns defaults until something is persisted,
 * `update()` merges a partial patch and returns the resulting full config.
 */
export class InMemoryGestionRealIngestConfigRepository implements GestionRealIngestConfigRepository {
  private config: IngestConfig | null = null;

  async get(): Promise<IngestConfig> {
    return { ...(this.config ?? DEFAULTS) };
  }

  async update(patch: Partial<IngestConfig>): Promise<IngestConfig> {
    const current = this.config ?? DEFAULTS;
    this.config = {
      intervalMs: patch.intervalMs ?? current.intervalMs,
      windowMonths: patch.windowMonths ?? current.windowMonths,
      // Nullable FKs: distinguish "omitted" (keep) from "null" (clear).
      fiberProjectId:
        'fiberProjectId' in patch ? patch.fiberProjectId! ?? null : current.fiberProjectId,
      wirelessProjectId:
        'wirelessProjectId' in patch ? patch.wirelessProjectId! ?? null : current.wirelessProjectId,
    };
    return { ...this.config };
  }
}
