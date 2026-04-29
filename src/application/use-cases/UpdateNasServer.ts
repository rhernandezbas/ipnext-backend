import { NasServer } from '@domain/entities/nas';
import { NasRepository } from '@domain/ports/NasRepository';

export class UpdateNasServer {
  constructor(private readonly repo: NasRepository) {}

  async execute(id: string, data: Partial<NasServer>): Promise<NasServer | null> {
    return this.repo.updateNasServer(id, data);
  }
}
