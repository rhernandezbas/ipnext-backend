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
