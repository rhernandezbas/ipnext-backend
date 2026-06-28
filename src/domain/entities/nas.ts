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
  /**
   * pppoe-pool-ip: nombre del pool de FreeRADIUS (radippool) para este NAS.
   * No nulo ⟺ NAS en modo pool (las altas nuevas sin IP fija usan ipMode='pool').
   * Nulo/ausente ⟺ comportamiento legacy (el caller pre-elige la IP). Opcional para
   * no romper los literales NasServer preexistentes (la columna es nullable, default null).
   */
  poolName?: string | null;
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
