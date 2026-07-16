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
  /**
   * Which GR order state to ingest (server-side `estado` filter + app-side
   * re-filter). One of GR's valid states: PEND | CONF | CERR | ANUL.
   * Defaults to 'CONF' (confirmed orders).
   */
  sourceEstado: string;
  /**
   * install-pppoe-pregen (K1): plan/grupo RADIUS (radusergroup) usado al
   * pre-provisionar el PPPoE de una instalación ingestada. No hay mapping
   * determinístico plan GR ("300MB", "50/25MB") → grupo RADIUS ("IP-*"), así
   * que es un default configurable en runtime (mismo patrón que los project
   * FKs). Null = sin configurar → la pre-generación se DEGRADA a no-op aunque
   * el flag esté ON (un usuario RADIUS sin grupo no puede existir).
   */
  pppoeProfile: string | null;
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
