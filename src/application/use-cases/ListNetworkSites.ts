import { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';

export class ListNetworkSites {
  constructor(private readonly repo: NetworkSiteRepository) {}

  async execute() {
    return this.repo.findAll();
  }
}
