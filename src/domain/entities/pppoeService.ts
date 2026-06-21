/**
 * enforcedState (Fase C) — estado del CORTE de servicio, SEPARADO del `profile` comercial.
 * El `profile` de la DB siempre guarda el plan comercial; en el router puede estar cambiado a
 * `IP-REDUCCION` (reduce) o el secret `disabled` (block). Así `restore` devuelve el comercial.
 *   active   — sin corte (operando normal)
 *   reduced  — deudor: profile reducido en el router (IP-REDUCCION)
 *   blocked  — baja: secret deshabilitado en el router
 */
export type EnforcedState = 'active' | 'reduced' | 'blocked';

/** Acción de enforcement on-demand sobre un PPPoE. */
export type EnforcementAction = 'reduce' | 'block' | 'restore';

/** Estado destino (enforcedState) que deja cada acción. Conocimiento puro de dominio. */
export function enforcedStateForAction(action: EnforcementAction): EnforcedState {
  switch (action) {
    case 'reduce':  return 'reduced';
    case 'block':   return 'blocked';
    case 'restore': return 'active';
  }
}

export interface PppoeService {
  id: string;
  username: string;            // name del /ppp secret — clave de upsert
  password: string;            // verdad técnica del router
  profile: string | null;     // /ppp profile COMERCIAL (IP-Air-* / *-PUB) — NO se pisa al cortar
  remoteAddress: string | null; // IP fija (remote-address): CGNAT o pública
  status: string;             // enabled | disabled (del secret) | terminated (baja HARD: user borrado del RADIUS, IP liberada)
  nasId: string;              // router donde vive (FK NasServer)
  contractId: string | null; // FK Contract — null = sin contrato asociado aún
  enforcedState: EnforcedState; // Fase C: estado del corte (default 'active')
  createdAt: string;
}
