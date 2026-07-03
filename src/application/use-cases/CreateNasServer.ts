import { NasServer, maskNasServerSecrets } from '@domain/entities/nas';
import { NasRepository } from '@domain/ports/NasRepository';

export class CreateNasServer {
  constructor(private readonly repo: NasRepository) {}

  async execute(data: Omit<NasServer, 'id'>): Promise<NasServer> {
    // El repo persiste el secreto REAL; solo se enmascara la RESPUESTA que devolvemos.
    const created = await this.repo.createNasServer(data);
    return maskNasServerSecrets(created);
  }
}
