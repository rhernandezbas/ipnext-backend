import { NocBroadcastConfigRepository } from '@domain/ports/NocBroadcastConfigRepository';
import { NocBroadcastConfigDTO, toNocBroadcastConfigDTO } from '@application/dto/nocBroadcast.dto';

/**
 * N1 (noc-broadcast) — returns the NOC broadcast config as a MASKED DTO (the raw
 * apiKey is never exposed). The repo returns defaults when no row exists yet.
 */
export class GetNocBroadcastConfig {
  constructor(private readonly config: NocBroadcastConfigRepository) {}

  async execute(): Promise<NocBroadcastConfigDTO> {
    return toNocBroadcastConfigDTO(await this.config.get());
  }
}
