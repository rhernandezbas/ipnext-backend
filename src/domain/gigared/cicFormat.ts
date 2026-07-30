/**
 * gigared-tv-cic-reuse — validez de FORMATO de un CIC del partner.
 *
 * WHY (incidente 2026-07-30): el pool `unregistered` tenía un único CIC sin `internal_id`,
 * y su valor era `'00065470 4'` — con un byte 0x20 (ESPACIO) en la posición 8, corrupto en
 * el CRM del partner. El filtro anti-veneno validaba PRESENCIA del cic pero no su FORMATO,
 * así que ese CIC pasaba como candidato limpio. Con un solo candidato, el pick "aleatorio"
 * (`Math.floor(Math.random() * 1)`) es determinístico: se elegía SIEMPRE. El partner
 * respondía 403 `cic-ownership-error`, el adapter lo mapea a NotFound, y el operador veía
 * un 404 "Gigared account not found" en CADA alta, para TODOS los clientes.
 *
 * DECISIÓN DE DISEÑO (spec CIC-1) — se valida la CLASE DE CARACTERES, no la LONGITUD.
 * Todos los CICs observados tienen 10 dígitos, pero fijar `/^\d{10}$/` haría que un CIC de
 * otra longitud emitido por el partner bloquee el 100% de las altas: exactamente el fallo
 * que este módulo viene a evitar. Se rechaza el modo de falla OBSERVADO (un carácter no
 * numérico), no una suposición sobre el largo que no podemos verificar.
 *
 * Helper PURO de dominio: sin dependencias externas.
 */

const CIC_NUMERICO = /^\d+$/;

/** True sólo si el CIC es una cadena no vacía compuesta ÍNTEGRAMENTE por dígitos [0-9]. */
export function isValidCicFormat(cic: string | null | undefined): boolean {
  if (cic == null) return false;
  return CIC_NUMERICO.test(cic);
}
