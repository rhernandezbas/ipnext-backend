import { CannedResponseRepository } from '@domain/ports/CannedResponseRepository';
import { CannedResponseNotFoundError } from '@domain/errors/cannedResponses';

/**
 * Ola 4 (inbox-Chatwoot) — borra una respuesta rápida (hard-delete: no hay soft-delete
 * en este catálogo, a diferencia de las notas internas). Pre-chequea existencia para
 * devolver 404 tipado; el Prisma adapter trata P2025 (carrera) como no-op idempotente.
 */
export class DeleteCannedResponse {
  constructor(private readonly repo: CannedResponseRepository) {}

  async execute(id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new CannedResponseNotFoundError(id);
    await this.repo.delete(id);
  }
}
