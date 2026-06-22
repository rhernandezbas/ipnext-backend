export interface Plan {
  id: string;
  code: string;
  name: string;
  category: string;
  downloadKbps: number;
  uploadKbps: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Códigos de los planes de ENFORCEMENT (corte/reducción): IP-REDUCCION, IP-BAJA.
 * Son grupos de SISTEMA que el orchestrator POSEE y reserva (`is_reserved_groupname`) — Prominense
 * los lista en su catálogo local pero NO los sincroniza al RADIUS (el orchestrator rechaza el
 * PUT/DELETE de esos códigos). El criterio es el CÓDIGO (inmutable), NO la categoría (editable):
 * así ambos repos reservan la MISMA dimensión y no hay mismatch ni transiciones de categoría.
 * Mantener este set alineado con `is_reserved_groupname` del freeradius-orchestrator.
 * DEUDA (judgment-day 2026-06-22): (1) si se cambia `ROUTER_REDUCED_PROFILE` (config.ts) a un código
 * distinto de `IP-REDUCCION`, agregarlo acá también — hoy coinciden. (2) el `code` no se normaliza
 * (la comparación es case-sensitive): escribir mal el código (ej. `ip-reduccion`) lo trataría como
 * plan comercial. No se normaliza con uppercase porque los códigos comerciales son mixtos (`IP-Air-30-10`).
 */
export const ENFORCEMENT_PLAN_CODES = new Set<string>(['IP-REDUCCION', 'IP-BAJA']);

export function isEnforcementPlan(code: string): boolean {
  return ENFORCEMENT_PLAN_CODES.has(code);
}
