import { DomainError } from './index';

/**
 * Ola 4 (inbox-Chatwoot) — errores tipados del CRUD de respuestas rápidas.
 * El mapeo HTTP vive en errorHandler.ts statusMap (fuente única):
 *   SHORTCUT_TAKEN → 409 · CANNED_RESPONSE_NOT_FOUND → 404 · VALIDATION_ERROR → 400.
 */

/** El shortcut normalizado ya existe (UNIQUE) — otro registro lo ocupa. */
export class ShortcutTakenError extends DomainError {
  constructor(shortcut: string) {
    super(`A canned response with shortcut "${shortcut}" already exists`, 'SHORTCUT_TAKEN');
    this.name = 'ShortcutTakenError';
  }
}

export class CannedResponseNotFoundError extends DomainError {
  constructor(id: string) {
    super(`CannedResponse with id ${id} not found`, 'CANNED_RESPONSE_NOT_FOUND');
    this.name = 'CannedResponseNotFoundError';
  }
}

/**
 * Reutiliza el code `VALIDATION_ERROR` (400, ya en statusMap) — mismo criterio que el
 * resto del router de messaging: shortcut que normaliza a vacío o content vacío tras trim.
 */
export class CannedResponseValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'CannedResponseValidationError';
  }
}
