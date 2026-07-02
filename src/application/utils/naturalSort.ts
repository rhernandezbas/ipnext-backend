/**
 * Orden natural de planes — numeric-aware, case-insensitive.
 *
 * Decisión post-review 2026-07-01: la clave de orden es `code` (es lo que el
 * catálogo FE muestra, ej. IP-Air-20-10), con desempate por `name` y desempate
 * final por `id` para garantizar un orden TOTAL determinista. Los fixtures
 * code===name de la primera iteración enmascaraban el mismatch de clave.
 *
 * Todas las claves llevan guard null/undefined (`?? ''`): un plan con code o
 * name faltante NUNCA tira TypeError — el string vacío compara primero, así que
 * queda al principio en posición determinista.
 */

/** Claves que participan del orden. Estructural: cualquier objeto con estas props sirve. */
export interface PlanOrderKeys {
  id?: string | null;
  code?: string | null;
  name?: string | null;
}

/**
 * Compare natural de strings: usa localeCompare con { numeric: true, sensitivity: 'base' }
 * para que segmentos numéricos se comparen por valor (20 < 50 < 100) y no como strings.
 * Null-safe: null/undefined se tratan como string vacío.
 */
export function naturalCompare(a: string | null | undefined, b: string | null | undefined): number {
  return (a ?? '').localeCompare(b ?? '', undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Comparator de planes para el catálogo: `code` (natural) → `name` (natural) → `id`.
 * El desempate por `id` usa comparación binaria de code units (no locale) para
 * garantizar orden total incluso entre ids que solo difieren en case.
 */
export function planOrderComparator(a: PlanOrderKeys, b: PlanOrderKeys): number {
  const byCode = naturalCompare(a.code, b.code);
  if (byCode !== 0) return byCode;
  const byName = naturalCompare(a.name, b.name);
  if (byName !== 0) return byName;
  const idA = a.id ?? '';
  const idB = b.id ?? '';
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}
