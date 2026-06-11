import type { GigaredConfigRepository } from '@domain/ports/GigaredConfigRepository';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { GigaredConfigDTO } from '@application/dto/gigared.dto';
import { GIGARED_FLAG, maskConfig } from './GetGigaredConfig';

/**
 * UpdateGigaredConfig (#47) — applies a partial patch to the config (apiKey/baseUrl)
 * and, when `enabled` is present, toggles the `gigared-integration` feature flag (D4).
 * Returns the masked DTO. Omitted fields are left unchanged.
 */
export class UpdateGigaredConfig {
  constructor(
    private readonly configRepo: GigaredConfigRepository,
    private readonly flagRepo: FeatureFlagRepository,
  ) {}

  async execute(patch: { apiKey?: string; baseUrl?: string; enabled?: boolean }): Promise<GigaredConfigDTO> {
    const configPatch: { apiKey?: string; baseUrl?: string } = {};
    if (patch.apiKey !== undefined) configPatch.apiKey = patch.apiKey;
    if (patch.baseUrl !== undefined) configPatch.baseUrl = patch.baseUrl;

    const cfg =
      Object.keys(configPatch).length > 0
        ? await this.configRepo.update(configPatch)
        : await this.configRepo.get();

    let enabled: boolean;
    if (patch.enabled !== undefined) {
      const flag = await this.flagRepo.setEnabled(GIGARED_FLAG, patch.enabled);
      enabled = flag.enabled;
    } else {
      enabled = (await this.flagRepo.get(GIGARED_FLAG))?.enabled ?? false;
    }

    return maskConfig(cfg.apiKey, cfg.baseUrl, cfg.updatedAt, enabled);
  }
}
