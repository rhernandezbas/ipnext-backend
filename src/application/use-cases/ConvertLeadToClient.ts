import { LeadRepository } from '@domain/ports/LeadRepository';
import { Lead } from '@domain/entities/lead';

export class ConvertLeadToClient {
  constructor(private readonly repo: LeadRepository) {}

  execute(id: string, clientId: string): Promise<Lead | null> {
    return this.repo.convertToClient(id, clientId);
  }
}
