import { CannedResponse } from '@domain/entities/cannedResponse';

/** Output DTO — nunca exponer la fila Prisma cruda. Fechas serializadas a ISO. */
export interface CannedResponseDto {
  id: string;
  shortcut: string;
  content: string;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toCannedResponseDto(c: CannedResponse): CannedResponseDto {
  return {
    id: c.id,
    shortcut: c.shortcut,
    content: c.content,
    createdById: c.createdById,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/**
 * Normaliza el shortcut a un slug lowercase ESTABLE. Pasos:
 *   1. Decompone acentos (NFD) y descarta las marcas combinantes (U+0300–U+036F) →
 *      "Señal" → "senal", "día" → "dia" (evita mutilar letras acentuadas).
 *   2. trim + lowercase.
 *   3. Quita la(s) barra(s) inicial(es) que el usuario podría tipear ("/saludo").
 *   4. Colapsa espacios/whitespace y underscores a un único '-'.
 *   5. Descarta todo lo que no sea [a-z0-9-].
 *   6. Colapsa guiones repetidos y recorta los de los bordes.
 *
 * Ejemplos: "  Saludo Cliente " → "saludo-cliente"; "/Saludo" → "saludo";
 * "Señal Baja" → "senal-baja". Devuelve '' si no queda ningún carácter válido
 * (el use case lo trata como CannedResponseValidationError).
 */
export function normalizeShortcut(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}
