/**
 * #81 — identidad de TV secuencial POR CLIENTE.
 *
 * El partner (CUA/Gigared) QUEMA el internal_id al primer uso (mapeo append-only). Una segunda
 * alta de TV con el mismo Client.id crudo falla ("ID interno ya está en uso"). Por eso la identidad
 * de TV es por cliente y secuencial: cada reactivación incrementa un seq y produce un internal_id
 * NUEVO, nunca quemado.
 *
 * seq <= 0  → el Client.id pelado: la identidad de HOY (back-compat de todos los clientes vigentes
 *             y de toda alta nueva).
 * seq  > 0  → `{clientId}-{seq}`: una identidad fresca por cada reactivación post-baja.
 *
 * Helper PURO de dominio: sin dependencias externas.
 */
export function currentTvInternalId(clientId: string, seq: number): string {
  return seq <= 0 ? clientId : `${clientId}-${seq}`;
}

/**
 * gigared-tv-cic-reuse — el INVERSO de `currentTvInternalId`.
 *
 * Responde: "este `internal_id` que el partner tiene colgado de un CIC del pool, ¿es NUESTRO
 * y de qué cliente?". Es el primer eslabón de la invariante de reutilización de CICs.
 *
 * ESTRICTO POR DISEÑO: sólo reconoce el formato que nosotros emitimos — un UUID de Client.id,
 * opcionalmente con el sufijo `-{seq}` de re-alta (#81). Cualquier otra cosa devuelve `null`,
 * lo que significa "la identidad NO es nuestra" y el CIC NUNCA se reutiliza.
 *
 * La basura cae al lado SEGURO (no reutilizar), jamás al permisivo: un falso positivo acá
 * asignaría a un cliente nuevo un CIC que carga la identidad de un tercero VIVO — que es
 * literalmente el incidente Centeno.
 */
const TV_INTERNAL_ID =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:-(\d+))?$/;

export function parseTvInternalId(
  internalId: string | null | undefined,
): { clientId: string; seq: number } | null {
  if (internalId == null || internalId === '') return null;
  const m = TV_INTERNAL_ID.exec(internalId);
  if (!m) return null;
  return { clientId: m[1], seq: m[2] === undefined ? 0 : Number(m[2]) };
}
