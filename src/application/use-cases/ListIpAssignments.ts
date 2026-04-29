import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';

export class ListIpAssignments {
  constructor(private readonly repo: IpNetworkRepository) {}

  async execute() {
    return this.repo.findAllAssignments();
  }
}
