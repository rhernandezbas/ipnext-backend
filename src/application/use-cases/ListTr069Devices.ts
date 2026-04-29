import { Tr069Repository } from '@domain/ports/Tr069Repository';

export class ListTr069Devices {
  constructor(private readonly repo: Tr069Repository) {}

  async execute() {
    return this.repo.findAllDevices();
  }
}
