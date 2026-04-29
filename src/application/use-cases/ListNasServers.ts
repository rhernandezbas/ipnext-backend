import { NasRepository } from '@domain/ports/NasRepository';

export class ListNasServers {
  constructor(private readonly repo: NasRepository) {}

  async execute() {
    return this.repo.findAllNasServers();
  }
}
