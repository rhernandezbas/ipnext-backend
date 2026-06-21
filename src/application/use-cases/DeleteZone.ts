import { ZoneRepository } from '@domain/ports/ZoneRepository';
import { ZoneNotFoundError } from '@domain/errors/zone';

export class DeleteZone {
  constructor(private readonly repo: ZoneRepository) {}

  async execute(id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new ZoneNotFoundError(id);
    await this.repo.delete(id);
  }
}
