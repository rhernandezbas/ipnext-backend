/**
 * Typed config for the Gestión Real installation-order ingest. Backed by a
 * single-row table; `get()` returns hardcoded defaults when no row exists yet.
 */
export interface IngestConfig {
  /** Scheduler tick interval in ms. */
  intervalMs: number;
  /** How far back (in months) to query GR orders. */
  windowMonths: number;
  /** Target project for FIBER-classified orders. Null = unset. */
  fiberProjectId: string | null;
  /** Target project for WIRELESS-classified orders. Null = unset. */
  wirelessProjectId: string | null;
}

/**
 * Port for reading/updating the ingest config. The application layer depends on
 * this; Prisma/InMemory adapters implement it.
 */
export interface GestionRealIngestConfigRepository {
  /** Current config; returns defaults if no row has been persisted yet. */
  get(): Promise<IngestConfig>;
  /** Apply a partial patch and return the resulting full config. */
  update(patch: Partial<IngestConfig>): Promise<IngestConfig>;
}
