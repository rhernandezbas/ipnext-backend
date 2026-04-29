import { PartnerRepository } from '@domain/ports/PartnerRepository';

export class DeletePartner {
  constructor(private readonly repo: PartnerRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
}
