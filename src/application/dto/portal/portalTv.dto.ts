/**
 * EPIC v3 (clave de TV del portal) — `GET /api/portal/tv/:contractId`.
 * Contrato PÚBLICO (apps instaladas): solo agregar campos, jamás tocar estos.
 * `hasTv:false` es un estado NORMAL (200), mismo criterio que la elegibilidad
 * WiFi. NUNCA viaja la password por este DTO — solo el login (GIGA{abonado}).
 */
export interface PortalTvStatusDto {
  hasTv: boolean;
  login: string | null;
}
