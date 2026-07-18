/**
 * N1 (noc-broadcast) — typed config for the NOC WhatsApp broadcast engine, backed
 * by a single-row table (`@default("singleton")`). `get()` returns hardcoded
 * defaults when no row exists yet. Molde: `GestionRealIngestConfigRepository`.
 *
 * The credentials point at a self-hosted Evolution API instance (unofficial
 * WhatsApp API on a Raspberry Pi, instancia "ronald noc"), dedicated to pushing
 * network news/tasks to the "noc lider" channel. This is the FOUNDATION that N2
 * (news) and N3 (network tasks) consume.
 */
export interface NocBroadcastConfig {
  /** Master switch. `false` = broadcast disabled (config kept but nothing is sent). */
  enabled: boolean;
  /** Base URL of the Evolution API instance, e.g. http://pi.local:8080. '' = unset. */
  evolutionBaseUrl: string;
  /** Evolution API key (header `apikey`). SECRET — never serialized in a read DTO. '' = unset. */
  evolutionApiKey: string;
  /** Evolution instance name, e.g. "ronald noc". '' = unset. */
  evolutionInstance: string;
  /** JID/id of the target "noc lider" channel/group. '' = unset. */
  targetChat: string;
  /** Public base URL of the app used to build deep links, e.g. http://190.7.234.37:7778. '' = unset. */
  appPublicUrl: string;
}

/** Hardcoded defaults returned before the singleton row exists (all opt-in OFF/empty). */
export const NOC_BROADCAST_DEFAULTS: NocBroadcastConfig = {
  enabled: false,
  evolutionBaseUrl: '',
  evolutionApiKey: '',
  evolutionInstance: '',
  targetChat: '',
  appPublicUrl: '',
};

/**
 * True only when the broadcast can actually send: enabled AND every Evolution
 * field non-empty. `appPublicUrl` is DELIBERATELY excluded — it is only needed to
 * build the deep link (BroadcastToNoc guards it separately), not to reach the API.
 * Single source of truth shared by the gateway (fail-fast guard) and the read DTO
 * (`configured` convenience flag for the settings card).
 */
export function isNocBroadcastConfigured(cfg: NocBroadcastConfig): boolean {
  return (
    cfg.enabled &&
    cfg.evolutionBaseUrl !== '' &&
    cfg.evolutionApiKey !== '' &&
    cfg.evolutionInstance !== '' &&
    cfg.targetChat !== ''
  );
}

/**
 * Port for reading/updating the single-row NOC broadcast config. The application
 * layer depends on this; Prisma/InMemory adapters implement it. `update()` applies
 * only the keys PRESENT in the patch (omitted keys are preserved).
 */
export interface NocBroadcastConfigRepository {
  /** Current config; returns defaults if no row has been persisted yet. */
  get(): Promise<NocBroadcastConfig>;
  /** Apply a partial patch (present keys only) and return the resulting full config. */
  update(patch: Partial<NocBroadcastConfig>): Promise<NocBroadcastConfig>;
}
