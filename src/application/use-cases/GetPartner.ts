import { PartnerRepository } from '@domain/ports/PartnerRepository';
import { Partner } from '@domain/entities/partner';

export class GetPartner {
  constructor(private readonly repo: PartnerRepository) {}

  execute(id: string): Promise<Partner | null> {
    return this.repo.findById(id);
  }
}
