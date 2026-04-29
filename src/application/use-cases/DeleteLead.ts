import { LeadRepository } from '@domain/ports/LeadRepository';

export class DeleteLead {
  constructor(private readonly repo: LeadRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
}
