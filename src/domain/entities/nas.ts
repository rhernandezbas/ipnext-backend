export type NasType = 'mikrotik_api' | 'radius_orchestrator' | 'cisco' | 'ubiquiti' | 'cambium' | 'other';

/** Un NAS cuyo aprovisionamiento/enforcement se rutea por el radius-orchestrator (RADIUS HA),
 *  en vez de hablarle directo al MikroTik por RouterOS. */
export function routesViaOrchestrator(type: NasType): boolean {
  return type === 'radius_orchestrator';
}

export interface NasServer {
  id: string;
  name: string;
  type: NasType;
  ipAddress: string;
  radiusSecret: string;       // masked in responses: "••••••••"
  nasIpAddress: string;
  apiPort: number | null;     // for MikroTik API
  apiLogin: string | null;
  apiPassword: string | null; // masked
  status: 'active' | 'inactive' | 'error';
  lastSeen: string | null;
  clientCount: number;
  description: string;
}

export interface RadiusConfig {
  authPort: number;           // default 1812
  acctPort: number;           // default 1813
  coaPort: number;            // default 3799
  sessionTimeout: number;     // seconds
  idleTimeout: number;        // seconds
  interimUpdateInterval: number;
  nasType: string;
  enableCoa: boolean;
  enableAccounting: boolean;
}

/** Máscara con la que se ocultan los secretos de un NAS en las respuestas de lectura. */
export const NAS_SECRET_MASK = '••••••••';

/**
 * Devuelve una copia de `nas` con radiusSecret/apiPassword reemplazados por la máscara,
 * SOLO si el valor es no-nulo y no-vacío. Un null o '' se preserva tal cual (no se enmascara).
 * Genérico para preservar campos aditivos (ej. displayType del DTO).
 */
export function maskNasServerSecrets<T extends { radiusSecret: string; apiPassword: string | null }>(nas: T): T {
  return {
    ...nas,
    radiusSecret: nas.radiusSecret ? NAS_SECRET_MASK : nas.radiusSecret,
    apiPassword: nas.apiPassword ? NAS_SECRET_MASK : nas.apiPassword,
  } as T;
}
