import { Ipv6Network } from '@domain/entities/network';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';

export class CreateIpv6Network {
  constructor(private readonly repo: IpNetworkRepository) {}

  async execute(data: Omit<Ipv6Network, 'id'>) {
    return this.repo.createIpv6Network(data);
  }
}
