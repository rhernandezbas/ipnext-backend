/**
 * install-pppoe-pregen (K1) — generador PURO y DETERMINÍSTICO de credenciales
 * PPPoE para la pre-provisión de instalaciones de Gestión Real.
 *
 * Reglas de negocio (decisión final del usuario):
 *  - `username` = nombre + apellido + númeroDeContrato, TODO minúscula, sin
 *    espacios, sin acentos/diacríticos (ñ→n), solo `[a-z0-9]`.
 *    Ej: "HERNANDEZ RONALD" + contrato 45123 → `ronaldhernandez45123`.
 *    Es ÚNICO por construcción (el número de contrato GR es único), así que NO
 *    hay contadores de colisión. Y es determinístico: un re-ingest de la misma
 *    orden regenera exactamente el mismo username (idempotencia por diseño).
 *  - `password` = nombre + "1234" LITERAL (el sufijo es FIJO a propósito —
 *    la clave se dicta por teléfono al instalador/cliente). Ej: `ronald1234`.
 *
 * Split del nombre: `Client.name` viene de GR como "APELLIDO(S) NOMBRE(S)".
 * Heurística determinística: apellido = PRIMER token, nombre = ÚLTIMO token.
 *   - "HERNANDEZ RONALD"              → nombre=ronald, apellido=hernandez
 *   - "HERNANDEZ BASTIDAS RONALD JOSE" → nombre=jose,  apellido=hernandez
 * Imperfecta para nombres/apellidos compuestos, pero determinística — y la
 * unicidad la garantiza el contrato igual. Un nombre de UN solo token (razón
 * social) se usa una sola vez (nunca duplicado nombre+apellido).
 *
 * Pure function: sin I/O, sin random, sin reloj. Mismo input → mismo output.
 */

export interface PppoeCredentials {
  username: string;
  password: string;
}

/** Sufijo FIJO de la clave generada (se dicta por teléfono — decisión K1). */
export const PPPOE_PASSWORD_SUFFIX = '1234';

/** minúscula + sin diacríticos (NFD strip de combining marks U+0300–U+036F, ñ→n) + solo [a-z0-9]. */
function normalizeToken(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Genera las credenciales PPPoE de un contrato GR a partir del nombre del
 * cliente (formato GR "APELLIDO(S) NOMBRE(S)") y el número de contrato.
 */
export function generatePppoeCredentials(
  clientName: string,
  contractNumber: string,
): PppoeCredentials {
  const tokens = clientName.split(/\s+/).filter(t => t.length > 0);
  const apellido = normalizeToken(tokens[0] ?? '');
  const nombre = normalizeToken(tokens[tokens.length - 1] ?? '');
  const contract = normalizeToken(contractNumber);

  // Un solo token (razón social / nombre incompleto): usarlo UNA sola vez.
  const nameParts = tokens.length <= 1 ? nombre : nombre + apellido;

  return {
    username: nameParts + contract,
    password: nombre + PPPOE_PASSWORD_SUFFIX,
  };
}
