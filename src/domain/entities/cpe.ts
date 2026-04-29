export type CpeStatus = 'online' | 'offline' | 'unconfigured' | 'error';
export type CpeType = 'router' | 'onu' | 'ont' | 'modem' | 'ap' | 'cpe_radio';

export interface CpeDevice {
  id: string;
  serialNumber: string;
  model: string;
  manufacturer: string;
  type: CpeType;
  macAddress: string;
  ipAddress: string | null;
  status: CpeStatus;
  clientId: string | null;
  clientName: string | null;
  nasId: string | null;
  networkSiteId: string | null;
  firmwareVersion: string;
  lastSeen: string | null;
  signal: number | null;
  connectedAt: string | null;
  description: string;
}
