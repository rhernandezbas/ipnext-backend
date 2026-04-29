import { Tr069Repository } from '@domain/ports/Tr069Repository';

export class DeleteTr069Device {
  constructor(private readonly repo: Tr069Repository) {}

  async execute(id: string) {
    return this.repo.deleteDevice(id);
  }
}
