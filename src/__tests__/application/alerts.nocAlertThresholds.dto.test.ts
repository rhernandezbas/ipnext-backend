/**
 * F1 (noc-alerts-config) — DTO shape for `GET/PUT /api/alerts/thresholds`.
 * The wire shape is FLAT (no `{data: ...}` envelope) and field names are
 * camelCase EXACT — the Rust collector (`ipnext-noc-collector/src/config.rs`)
 * `serde_json::from_str`s the response body directly into its `Thresholds`
 * struct (`#[serde(rename_all = "camelCase")]`).
 */
import {
  toNocAlertThresholdsConfigDto,
  UpdateNocAlertThresholdsSchema,
} from '@application/dto/nocAlertThresholds.dto';
import { NocAlertThresholdsConfig } from '@domain/ports/NocAlertThresholdsConfigRepository';

describe('toNocAlertThresholdsConfigDto', () => {
  it('maps the domain config 1:1 into the flat camelCase wire shape', () => {
    const config: NocAlertThresholdsConfig = {
      critDbm: -30,
      warnDbm: -27,
      deltaAlert: 2.0,
      ponMinAbon: 2,
      ponDelta: 1.5,
    };
    expect(toNocAlertThresholdsConfigDto(config)).toEqual({
      critDbm: -30,
      warnDbm: -27,
      deltaAlert: 2.0,
      ponMinAbon: 2,
      ponDelta: 1.5,
    });
  });
});

describe('UpdateNocAlertThresholdsSchema', () => {
  it('accepts a complete numeric payload', () => {
    const parsed = UpdateNocAlertThresholdsSchema.safeParse({
      critDbm: -28,
      warnDbm: -25,
      deltaAlert: 1.5,
      ponMinAbon: 3,
      ponDelta: 1.0,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a payload missing a required field (NOT partial)', () => {
    const parsed = UpdateNocAlertThresholdsSchema.safeParse({
      critDbm: -28,
      warnDbm: -25,
      deltaAlert: 1.5,
      ponMinAbon: 3,
      // ponDelta missing
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a payload with a non-numeric field', () => {
    const parsed = UpdateNocAlertThresholdsSchema.safeParse({
      critDbm: '-28', // string, not number
      warnDbm: -25,
      deltaAlert: 1.5,
      ponMinAbon: 3,
      ponDelta: 1.0,
    });
    expect(parsed.success).toBe(false);
  });
});
