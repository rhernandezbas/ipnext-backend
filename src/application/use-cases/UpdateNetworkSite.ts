import { NetworkSite } from '@domain/entities/networkSite';
import { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';

export class UpdateNetworkSite {
  constructor(private readonly repo: NetworkSiteRepository) {}

  async execute(id: string, data: Partial<NetworkSite>) {
    return this.repo.update(id, data);
  }
}
