/**
 * parsePagination — customer-portal-api (fix wave M2).
 *
 * Parseo ESTRICTO de `page`/`limit` de querystring, compartido por TODAS las
 * rutas paginadas del portal (self-service y CRUD admin) — fix de CLASE, no de
 * instancia: antes cada ruta hacia su propio `+page` / `Number(page)` y un
 * `?page=abc` colaba `NaN` hasta el adapter (Prisma: skip/take NaN = 500;
 * in-memory: `page: NaN` serializado como `null`). Reglas:
 *
 *  - solo digitos (entero >= 1); cualquier otra cosa (NaN, negativo, '1.5',
 *    '1e3', vacio, ausente) => `undefined` y el use case aplica su default
 *  - `limit` ademas se CAPEA a MAX_PAGE_LIMIT (100): el techo de trabajo por
 *    request lo pone el servidor, jamas el querystring del cliente
 */
export const MAX_PAGE_LIMIT = 100;

/** Entero >= 1 estricto (solo digitos) o undefined. */
export function parsePositiveIntParam(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

export interface ParsedPagination {
  page: number | undefined;
  limit: number | undefined;
}

export function parsePagination(query: Record<string, unknown>): ParsedPagination {
  const page = parsePositiveIntParam(query['page']);
  const rawLimit = parsePositiveIntParam(query['limit']);
  const limit = rawLimit === undefined ? undefined : Math.min(rawLimit, MAX_PAGE_LIMIT);
  return { page, limit };
}
