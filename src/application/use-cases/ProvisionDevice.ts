import { Tr069Repository } from '@domain/ports/Tr069Repository';

export class ProvisionDevice {
  constructor(private readonly repo: Tr069Repository) {}

  async execute(id: string) {
    return this.repo.provisionDevice(id);
  }
}
