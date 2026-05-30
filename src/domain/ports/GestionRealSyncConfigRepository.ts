/**
 * Typed config for the Gestión Real client sync. Backed by a single-row table;
 * `get()` returns hardcoded defaults when no row exists yet.
 *
 * `estados` is exposed as a `string[]` at this boundary; the comma-joined storage
 * representation lives entirely inside the adapters.
 */
export interface SyncConfig {
  /** Scheduler tick interval in ms. */
  intervalMs: number;
  /** GR estado codes to scan (1=Activo, 2=Deudor, 3=Inactivo, 4=Incobrable, 6=Baja). */
  estados: string[];
}

/**
 * Port for reading/updating the client-sync config. The application layer depends
 * on this; Prisma/InMemory adapters implement it.
 */
export interface GestionRealSyncConfigRepository {
  /** Current config; returns defaults if no row has been persisted yet. */
  get(): Promise<SyncConfig>;
  /** Apply a partial patch and return the resulting full config. */
  update(patch: Partial<SyncConfig>): Promise<SyncConfig>;
}
