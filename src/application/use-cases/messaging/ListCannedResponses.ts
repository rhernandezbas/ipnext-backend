import { CannedResponseRepository } from '@domain/ports/CannedResponseRepository';
import { CannedResponseDto, toCannedResponseDto } from '@application/dto/cannedResponse.dto';

/**
 * Ola 4 (inbox-Chatwoot) — lista el catálogo de respuestas rápidas para el picker del
 * composer, ordenado por shortcut ASC. `q` (opcional) es la búsqueda del picker: matchea
 * shortcut O content (substring case-insensitive, resuelto en el repo). Sólo se pasa `q`
 * cuando tiene contenido (una query vacía lista TODO).
 */
export class ListCannedResponses {
  constructor(private readonly repo: CannedResponseRepository) {}

  async execute(query?: { q?: string }): Promise<CannedResponseDto[]> {
    const q = query?.q?.trim();
    const items = await this.repo.list(q ? { q } : undefined);
    return items.map(toCannedResponseDto);
  }
}
