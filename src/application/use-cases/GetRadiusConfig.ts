import { NasRepository } from '@domain/ports/NasRepository';

export class GetRadiusConfig {
  constructor(private readonly repo: NasRepository) {}

  async execute() {
    return this.repo.getRadiusConfig();
  }
}
