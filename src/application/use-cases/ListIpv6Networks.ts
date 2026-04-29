import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';

export class ListIpv6Networks {
  constructor(private readonly repo: IpNetworkRepository) {}

  async execute() {
    return this.repo.findAllIpv6Networks();
  }
}
