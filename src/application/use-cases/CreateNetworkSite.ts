import { NetworkSite } from '@domain/entities/networkSite';
import { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';

export class CreateNetworkSite {
  constructor(private readonly repo: NetworkSiteRepository) {}

  async execute(data: Omit<NetworkSite, 'id'>) {
    return this.repo.create(data);
  }
}
