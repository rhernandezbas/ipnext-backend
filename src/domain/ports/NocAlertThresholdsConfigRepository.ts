/**
 * F1 (noc-alerts-config) — typed config for the fiber-alert thresholds
 * (`NocAlertThresholdsConfig`), backed by a single-row table
 * (`@default("singleton")`). Molde: `NocBroadcastConfigRepository` /
 * `GestionRealIngestConfigRepository`.
 *
 * FIELD NAMES ARE THE WIRE CONTRACT — verified against
 * `ipnext-noc-collector/src/config.rs::Thresholds` (`#[serde(rename_all =
 * "camelCase")]`, its own field names are snake_case → camelCase on the
 * wire): `critDbm`/`warnDbm`/`deltaAlert`/`ponMinAbon`/`ponDelta`, EXACT.
 * The Rust collector's `GET /api/alerts/thresholds` response is parsed with
 * `serde_json::from_str` straight into that struct — renaming a field here
 * silently breaks the collector's `fetch_thresholds()` (it falls back to
 * hardcoded defaults instead of erroring loud, so a drift would be a QUIET
 * regression, not a crash). Do not rename without updating BOTH repos.
 *
 * Defaults mirror `/etc/fibra_report.conf` on VM 130 (design.md,
 * spec.md "Threshold singleton with seeded defaults").
 */
export interface NocAlertThresholdsConfig {
  /** Rx (dBm) worse than this = Critical. */
  critDbm: number;
  /** Rx (dBm) worse than this = Warning. */
  warnDbm: number;
  /** Individual worsening (dB) that gets reported. */
  deltaAlert: number;
  /** Subscribers affected on a single PON to suspect a shared fiber/box issue. */
  ponMinAbon: number;
  /** Mean PON worsening (dB) to suspect a shared issue. */
  ponDelta: number;
}

/** Seeded defaults — current values in `/etc/fibra_report.conf` (VM 130). */
export const NOC_ALERT_THRESHOLDS_DEFAULTS: NocAlertThresholdsConfig = {
  critDbm: -30,
  warnDbm: -27,
  deltaAlert: 2.0,
  ponMinAbon: 2,
  ponDelta: 1.5,
};

/**
 * Port for reading/updating the single-row thresholds config. Unlike
 * `NocBroadcastConfigRepository.update()` (partial patch), `update()` here
 * replaces the FULL config — spec.md "Update validates required numeric
 * fields": the PUT contract requires all 5 fields present and numeric,
 * rejecting an incomplete payload BEFORE it reaches this port (Zod, at the
 * route) — there is no meaningful "partial" state to merge.
 */
export interface NocAlertThresholdsConfigRepository {
  /** Current config; returns the seeded defaults if no row has been persisted yet. */
  get(): Promise<NocAlertThresholdsConfig>;
  /** Replace the full config and return the resulting config. */
  update(config: NocAlertThresholdsConfig): Promise<NocAlertThresholdsConfig>;
}
