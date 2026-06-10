import { NetworkSite } from '@domain/entities/networkSite';
import { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';
import type { UispSiteRepository } from '@domain/ports/UispSiteRepository';
import { UispSiteLinkNotFoundError } from '@domain/errors/uisp';

export class UpdateNetworkSite {
  constructor(
    private readonly repo: NetworkSiteRepository,
    private readonly uispSiteRepo: UispSiteRepository | null = null,
  ) {}

  async execute(id: string, data: Partial<NetworkSite>) {
    // When uispSiteId is explicitly set (non-undefined) and non-null, validate it exists in mirror
    if (data.uispSiteId !== undefined && data.uispSiteId !== null) {
      if (!this.uispSiteRepo) {
        throw new UispSiteLinkNotFoundError(data.uispSiteId);
      }
      const mirror = await this.uispSiteRepo.findByUispId(data.uispSiteId);
      if (!mirror) {
        throw new UispSiteLinkNotFoundError(data.uispSiteId);
      }
    }
    return this.repo.update(id, data);
  }
}
