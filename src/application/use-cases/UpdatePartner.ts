import { PartnerRepository } from '@domain/ports/PartnerRepository';
import { Partner } from '@domain/entities/partner';

export class UpdatePartner {
  constructor(private readonly repo: PartnerRepository) {}

  execute(id: string, data: Partial<Partner>): Promise<Partner | null> {
    return this.repo.update(id, data);
  }
}
