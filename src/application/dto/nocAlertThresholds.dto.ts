import { z } from 'zod';
import { NocAlertThresholdsConfig } from '@domain/ports/NocAlertThresholdsConfigRepository';

// ── Read DTO ──────────────────────────────────────────────────────────────

/**
 * F1 (noc-alerts-config) — outbound DTO for `GET/PUT /api/alerts/thresholds`.
 * FLAT shape, no `{data: ...}` envelope, field names camelCase EXACT — the
 * Rust collector `serde_json::from_str`s this response body DIRECTLY into
 * `Thresholds` (`ipnext-noc-collector/src/config.rs`). Shape-identical to the
 * domain type today (no secrets to mask, unlike `NocBroadcastConfigDTO`), but
 * kept as its own type so the wire contract can evolve independently of
 * storage — same reasoning as `NocBroadcastConfigDTO`.
 */
export interface NocAlertThresholdsConfigDto {
  critDbm: number;
  warnDbm: number;
  deltaAlert: number;
  ponMinAbon: number;
  ponDelta: number;
}

export function toNocAlertThresholdsConfigDto(config: NocAlertThresholdsConfig): NocAlertThresholdsConfigDto {
  return {
    critDbm: config.critDbm,
    warnDbm: config.warnDbm,
    deltaAlert: config.deltaAlert,
    ponMinAbon: config.ponMinAbon,
    ponDelta: config.ponDelta,
  };
}

// ── Update input validation (PUT /thresholds) ────────────────────────────

/**
 * Inbound PUT body. spec.md "Update validates required numeric fields": ALL
 * 5 fields are REQUIRED and must be numbers — unlike `UpdateNocBroadcastConfigSchema`,
 * this is deliberately NOT `.partial()`. A missing field or a non-numeric
 * value fails validation here (→ 400 VALIDATION_ERROR at the route) BEFORE
 * any partial update could ever reach the repository.
 */
export const UpdateNocAlertThresholdsSchema = z.object({
  critDbm: z.number(),
  warnDbm: z.number(),
  deltaAlert: z.number(),
  // ponMinAbon is a subscriber COUNT (Rust `usize`) — must be a non-negative integer.
  ponMinAbon: z.number().int().nonnegative(),
  ponDelta: z.number(),
});

export type UpdateNocAlertThresholdsInput = z.infer<typeof UpdateNocAlertThresholdsSchema>;
