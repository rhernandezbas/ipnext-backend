import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';

export class DeleteIpNetwork {
  constructor(private readonly repo: IpNetworkRepository) {}

  async execute(id: string): Promise<boolean> {
    return this.repo.deleteNetwork(id);
  }
}
