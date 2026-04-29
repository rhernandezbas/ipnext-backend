import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';

export class ListIpPools {
  constructor(private readonly repo: IpNetworkRepository) {}

  async execute() {
    return this.repo.findAllPools();
  }
}
