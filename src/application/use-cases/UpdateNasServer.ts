import { NasServer, NAS_SECRET_MASK, maskNasServerSecrets } from '@domain/entities/nas';
import { NasRepository } from '@domain/ports/NasRepository';

export class UpdateNasServer {
  constructor(private readonly repo: NasRepository) {}

  async execute(id: string, data: Partial<NasServer>): Promise<NasServer | null> {
    // Sentinel de INPUT: no dejar que la máscara/vacío pisen el secreto real guardado.
    const sanitized: Partial<NasServer> = { ...data };
    for (const field of ['radiusSecret', 'apiPassword'] as const) {
      const v = sanitized[field];
      if (v === undefined || v === '' || v === NAS_SECRET_MASK) {
        delete sanitized[field];
      }
    }
    // El repo persiste el secreto REAL; solo se enmascara la RESPUESTA que devolvemos.
    const updated = await this.repo.updateNasServer(id, sanitized);
    return updated ? maskNasServerSecrets(updated) : null;
  }
}
