import { CpeRepository } from '@domain/ports/CpeRepository';

export class AssignCpeToClient {
  constructor(private readonly repo: CpeRepository) {}

  async execute(id: string, clientId: string, clientName: string) {
    return this.repo.assignToClient(id, clientId, clientName);
  }
}
