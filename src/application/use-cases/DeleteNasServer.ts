import { NasRepository } from '@domain/ports/NasRepository';

export class DeleteNasServer {
  constructor(private readonly repo: NasRepository) {}

  async execute(id: string): Promise<boolean> {
    return this.repo.deleteNasServer(id);
  }
}
