import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';

export class DeleteIpPool {
  constructor(private readonly repo: IpNetworkRepository) {}

  async execute(id: string): Promise<boolean> {
    return this.repo.deletePool(id);
  }
}
