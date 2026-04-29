import { RadiusConfig } from '@domain/entities/nas';
import { NasRepository } from '@domain/ports/NasRepository';

export class UpdateRadiusConfig {
  constructor(private readonly repo: NasRepository) {}

  async execute(data: Partial<RadiusConfig>): Promise<RadiusConfig> {
    return this.repo.updateRadiusConfig(data);
  }
}
