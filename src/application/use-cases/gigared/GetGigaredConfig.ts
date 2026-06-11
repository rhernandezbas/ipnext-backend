import type { GigaredConfigRepository } from '@domain/ports/GigaredConfigRepository';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { GigaredConfigDTO } from '@application/dto/gigared.dto';

export const GIGARED_FLAG = 'gigared-integration';

/** Mask a raw apiKey to a safe DTO — the full key NEVER leaves this boundary. */
export function maskConfig(
  apiKey: string,
  baseUrl: string,
  updatedAt: string,
  enabled: boolean,
): GigaredConfigDTO {
  const configured = apiKey !== '';
  return {
    configured,
    apiKeyLast4: configured ? apiKey.slice(-4) : null,
    baseUrl,
    enabled,
    updatedAt: configured ? updatedAt : null,
  };
}

/**
 * GetGigaredConfig (#47) — returns the masked config + the integration flag state.
 * Masking happens HERE: the full apiKey is read but only `configured` + `apiKeyLast4`
 * are exposed (REQ gigared-config).
 */
export class GetGigaredConfig {
  constructor(
    private readonly configRepo: GigaredConfigRepository,
    private readonly flagRepo: FeatureFlagRepository,
  ) {}

  async execute(): Promise<GigaredConfigDTO> {
    const cfg = await this.configRepo.get();
    const flag = await this.flagRepo.get(GIGARED_FLAG);
    return maskConfig(cfg.apiKey, cfg.baseUrl, cfg.updatedAt, flag?.enabled ?? false);
  }
}
