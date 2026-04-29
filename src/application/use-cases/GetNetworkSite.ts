import { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';

export class GetNetworkSite {
  constructor(private readonly repo: NetworkSiteRepository) {}

  async execute(id: string) {
    return this.repo.findById(id);
  }
}
