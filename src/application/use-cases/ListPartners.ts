import { PartnerRepository } from '@domain/ports/PartnerRepository';
import { Partner } from '@domain/entities/partner';

export class ListPartners {
  constructor(private readonly repo: PartnerRepository) {}

  execute(): Promise<Partner[]> {
    return this.repo.findAll();
  }
}
