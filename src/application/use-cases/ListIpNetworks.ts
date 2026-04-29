import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';

export class ListIpNetworks {
  constructor(private readonly repo: IpNetworkRepository) {}

  async execute() {
    return this.repo.findAllNetworks();
  }
}
