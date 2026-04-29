import { NasServer } from '@domain/entities/nas';
import { NasRepository } from '@domain/ports/NasRepository';

export class CreateNasServer {
  constructor(private readonly repo: NasRepository) {}

  async execute(data: Omit<NasServer, 'id'>): Promise<NasServer> {
    return this.repo.createNasServer(data);
  }
}
