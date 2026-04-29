export type NasType = 'mikrotik_api' | 'mikrotik_radius' | 'cisco' | 'ubiquiti' | 'cambium' | 'other';

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
