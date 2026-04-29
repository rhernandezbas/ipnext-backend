import { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';

export class DeleteNetworkSite {
  constructor(private readonly repo: NetworkSiteRepository) {}

  async execute(id: string) {
    return this.repo.delete(id);
  }
}
