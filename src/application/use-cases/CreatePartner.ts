import { PartnerRepository } from '@domain/ports/PartnerRepository';
import { Partner } from '@domain/entities/partner';

export class CreatePartner {
  constructor(private readonly repo: PartnerRepository) {}

  execute(data: Omit<Partner, 'id' | 'createdAt' | 'clientCount' | 'adminCount'>): Promise<Partner> {
    return this.repo.create(data);
  }
}
