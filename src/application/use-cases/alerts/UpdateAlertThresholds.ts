import { NocAlertThresholdsConfigRepository } from '@domain/ports/NocAlertThresholdsConfigRepository';
import {
  NocAlertThresholdsConfigDto,
  UpdateNocAlertThresholdsInput,
  toNocAlertThresholdsConfigDto,
} from '@application/dto/nocAlertThresholds.dto';

/**
 * F1 (noc-alerts-config) — replaces the fiber-alert thresholds singleton.
 * Human-only (`monitoring.manage`, session cookie) — the Rust collector's
 * `fiberIngestKey` is READ-ONLY on this resource (spec.md "Fiber collector
 * cannot edit thresholds via its API key"), enforced at the route (dual-auth
 * only applies to GET), not here.
 */
export class UpdateAlertThresholds {
  constructor(private readonly config: NocAlertThresholdsConfigRepository) {}

  async execute(input: UpdateNocAlertThresholdsInput): Promise<NocAlertThresholdsConfigDto> {
    const updated = await this.config.update(input);
    return toNocAlertThresholdsConfigDto(updated);
  }
}
