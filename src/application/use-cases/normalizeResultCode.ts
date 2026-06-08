/**
 * Normaliza un código de resultado para comparación tolerante a variaciones de
 * IClass: recorta espacios extremos, pasa a minúsculas, elimina puntuación final
 * (incluido ".") y colapsa espacios internos a uno solo.
 *
 * Conservador: NO toca la puntuación interna, por lo que códigos distintos
 * (ej. "Reparacion-A" vs "Reparacion-B") nunca se fusionan.
 */
export function normalizeResultCode(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+$/u, '') // elimina todos los no-alfanuméricos finales (incl. ".")
    .replace(/\s+/g, ' ');            // colapsa espacios internos
}
