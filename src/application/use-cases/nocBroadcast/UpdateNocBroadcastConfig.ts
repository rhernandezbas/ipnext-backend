import { NocBroadcastConfig, NocBroadcastConfigRepository } from '@domain/ports/NocBroadcastConfigRepository';
import {
  NocBroadcastConfigDTO,
  UpdateNocBroadcastConfigInput,
  toNocBroadcastConfigDTO,
} from '@application/dto/nocBroadcast.dto';

/**
 * N1 (noc-broadcast) — applies a validated partial patch to the NOC broadcast
 * config and returns the resulting MASKED DTO.
 *
 * apiKey rule: the secret is only overwritten when a NON-EMPTY value is provided.
 * An empty or absent `evolutionApiKey` preserves the stored key — a PUT that edits
 * other fields must never blank out the credential (the read DTO masks it, so a
 * FE round-trip cannot resend it).
 */
export class UpdateNocBroadcastConfig {
  constructor(private readonly config: NocBroadcastConfigRepository) {}

  async execute(input: UpdateNocBroadcastConfigInput): Promise<NocBroadcastConfigDTO> {
    const patch: Partial<NocBroadcastConfig> = {};
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.evolutionBaseUrl !== undefined) patch.evolutionBaseUrl = input.evolutionBaseUrl;
    if (input.evolutionInstance !== undefined) patch.evolutionInstance = input.evolutionInstance;
    if (input.targetChat !== undefined) patch.targetChat = input.targetChat;
    if (input.appPublicUrl !== undefined) patch.appPublicUrl = input.appPublicUrl;
    // Only overwrite the secret when a non-empty key is provided (else preserve).
    if (input.evolutionApiKey !== undefined && input.evolutionApiKey !== '') {
      patch.evolutionApiKey = input.evolutionApiKey;
    }

    const updated = await this.config.update(patch);
    return toNocBroadcastConfigDTO(updated);
  }
}
