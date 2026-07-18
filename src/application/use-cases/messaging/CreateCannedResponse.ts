import { CannedResponseRepository } from '@domain/ports/CannedResponseRepository';
import { ShortcutTakenError, CannedResponseValidationError } from '@domain/errors/cannedResponses';
import { CannedResponseDto, toCannedResponseDto, normalizeShortcut } from '@application/dto/cannedResponse.dto';

/**
 * Ola 4 (inbox-Chatwoot) — crea una respuesta rápida. Normaliza el shortcut a
 * slug lowercase (fuente única: `normalizeShortcut`), valida content no vacío y la
 * unicidad del shortcut (findByShortcut TOCTOU; el Prisma adapter re-mapea P2002 al
 * mismo ShortcutTakenError para cerrar la carrera). `createdById` es la atribución
 * soft del autor (nullable — SetNull en el borrado del usuario).
 */
export class CreateCannedResponse {
  constructor(private readonly repo: CannedResponseRepository) {}

  async execute(input: { shortcut: string; content: string; createdById?: string | null }): Promise<CannedResponseDto> {
    const shortcut = normalizeShortcut(input.shortcut ?? '');
    if (!shortcut) {
      throw new CannedResponseValidationError('shortcut must contain at least one alphanumeric character');
    }
    const content = (input.content ?? '').trim();
    if (!content) {
      throw new CannedResponseValidationError('content must be a non-empty string');
    }

    const existing = await this.repo.findByShortcut(shortcut);
    if (existing) throw new ShortcutTakenError(shortcut);

    const created = await this.repo.create({ shortcut, content, createdById: input.createdById ?? null });
    return toCannedResponseDto(created);
  }
}
