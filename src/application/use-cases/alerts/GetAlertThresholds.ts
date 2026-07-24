import { NocAlertThresholdsConfigRepository } from '@domain/ports/NocAlertThresholdsConfigRepository';
import { NocAlertThresholdsConfigDto, toNocAlertThresholdsConfigDto } from '@application/dto/nocAlertThresholds.dto';

/**
 * F1 (noc-alerts-config) — returns the current fiber-alert thresholds as a
 * DTO. The repo returns the seeded defaults when no row has been edited yet.
 * Read by BOTH the panel (human, `monitoring.manage`) and the Rust collector
 * (machine, `fiberIngestKey`) — see `alerts.routes.ts` GET /thresholds.
 */
export class GetAlertThresholds {
  constructor(private readonly config: NocAlertThresholdsConfigRepository) {}

  async execute(): Promise<NocAlertThresholdsConfigDto> {
    return toNocAlertThresholdsConfigDto(await this.config.get());
  }
}
