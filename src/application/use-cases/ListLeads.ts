import { LeadRepository } from '@domain/ports/LeadRepository';
import { Lead } from '@domain/entities/lead';

export class ListLeads {
  constructor(private readonly repo: LeadRepository) {}

  execute(): Promise<Lead[]> {
    return this.repo.findAll();
  }
}
