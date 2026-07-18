/**
 * N1 (noc-broadcast) — port for pushing a plain-text message to the NOC channel
 * via Evolution API. Adapter: `infrastructure/adapters/evolution/EvolutionApiHttpGateway`.
 *
 * Contract: the adapter reads the config AT CALL TIME (it is edited at runtime via
 * PUT /config), checks `isNocBroadcastConfigured`, and on `!configured` throws
 * `NocBroadcastNotConfiguredError` BEFORE touching the network. Any transport
 * failure (4xx/5xx/timeout/network) maps to `EvolutionApiError`.
 */
export interface NocBroadcastGateway {
  /** Sends `text` to the configured "noc lider" channel. See contract above. */
  sendText(text: string): Promise<void>;
}
