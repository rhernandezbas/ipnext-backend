import { CannedResponseRepository } from '@domain/ports/CannedResponseRepository';
import {
  ShortcutTakenError,
  CannedResponseNotFoundError,
  CannedResponseValidationError,
} from '@domain/errors/cannedResponses';
import { CannedResponseDto, toCannedResponseDto, normalizeShortcut } from '@application/dto/cannedResponse.dto';

/**
 * Ola 4 (inbox-Chatwoot) — edita una respuesta rápida. Patch parcial: sólo se tocan
 * los campos presentes. Renombrar renormaliza el shortcut y, si CAMBIA, revalida la
 * unicidad contra OTRO registro (renombrar al mismo slug es idempotente, no conflictúa).
 * El re-check final de `update === null` cubre el TOCTOU (borrado entre findById y update).
 */
export class UpdateCannedResponse {
  constructor(private readonly repo: CannedResponseRepository) {}

  async execute(id: string, patch: { shortcut?: string; content?: string }): Promise<CannedResponseDto> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new CannedResponseNotFoundError(id);

    const data: { shortcut?: string; content?: string } = {};

    if (patch.shortcut !== undefined) {
      const shortcut = normalizeShortcut(patch.shortcut);
      if (!shortcut) {
        throw new CannedResponseValidationError('shortcut must contain at least one alphanumeric character');
      }
      if (shortcut !== existing.shortcut) {
        const clash = await this.repo.findByShortcut(shortcut);
        if (clash && clash.id !== id) throw new ShortcutTakenError(shortcut);
      }
      data.shortcut = shortcut;
    }

    if (patch.content !== undefined) {
      const content = patch.content.trim();
      if (!content) {
        throw new CannedResponseValidationError('content must be a non-empty string');
      }
      data.content = content;
    }

    const updated = await this.repo.update(id, data);
    if (!updated) throw new CannedResponseNotFoundError(id);
    return toCannedResponseDto(updated);
  }
}
