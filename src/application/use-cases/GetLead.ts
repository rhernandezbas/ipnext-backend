import { LeadRepository } from '@domain/ports/LeadRepository';
import { Lead } from '@domain/entities/lead';

export class GetLead {
  constructor(private readonly repo: LeadRepository) {}

  execute(id: string): Promise<Lead | null> {
    return this.repo.findById(id);
  }
}
