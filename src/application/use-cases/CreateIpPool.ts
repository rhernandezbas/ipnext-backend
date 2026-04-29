import { IpPool } from '@domain/entities/network';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';

export class CreateIpPool {
  constructor(private readonly repo: IpNetworkRepository) {}

  async execute(data: Omit<IpPool, 'id'>): Promise<IpPool> {
    return this.repo.createPool(data);
  }
}
