import { CannedResponse } from '@domain/entities/cannedResponse';

export interface CannedResponseListQuery {
  /** Búsqueda del picker: substring case-insensitive contra shortcut O content. */
  q?: string;
}

export interface CannedResponseRepository {
  /** Ordenadas por shortcut ASC. `q` (si presente) filtra por shortcut/content. */
  list(query?: CannedResponseListQuery): Promise<CannedResponse[]>;
  findById(id: string): Promise<CannedResponse | null>;
  /** El shortcut se persiste SIEMPRE normalizado (lowercase-slug) — match exacto. */
  findByShortcut(shortcut: string): Promise<CannedResponse | null>;
  create(input: { shortcut: string; content: string; createdById: string | null }): Promise<CannedResponse>;
  update(id: string, patch: { shortcut?: string; content?: string }): Promise<CannedResponse | null>;
  delete(id: string): Promise<void>;
}
