import { NasRepository } from '@domain/ports/NasRepository';

export class GetNasServer {
  constructor(private readonly repo: NasRepository) {}

  async execute(id: string) {
    return this.repo.findNasServerById(id);
  }
}
