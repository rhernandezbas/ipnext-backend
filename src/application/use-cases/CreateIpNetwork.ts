import { IpNetwork } from '@domain/entities/network';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';

export class CreateIpNetwork {
  constructor(private readonly repo: IpNetworkRepository) {}

  async execute(data: Omit<IpNetwork, 'id'>): Promise<IpNetwork> {
    return this.repo.createNetwork(data);
  }
}
