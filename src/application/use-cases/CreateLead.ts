import { LeadRepository } from '@domain/ports/LeadRepository';
import { Lead } from '@domain/entities/lead';

export class CreateLead {
  constructor(private readonly repo: LeadRepository) {}

  execute(data: Omit<Lead, 'id' | 'createdAt' | 'convertedAt' | 'convertedClientId'>): Promise<Lead> {
    return this.repo.create({ ...data, status: 'new' });
  }
}
