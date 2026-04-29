import { LeadRepository } from '@domain/ports/LeadRepository';
import { Lead } from '@domain/entities/lead';

export class UpdateLead {
  constructor(private readonly repo: LeadRepository) {}

  execute(id: string, data: Partial<Lead>): Promise<Lead | null> {
    return this.repo.update(id, data);
  }
}
