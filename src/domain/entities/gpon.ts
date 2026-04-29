export interface OltDevice {
  id: string;
  name: string;
  ipAddress: string;
  model: string;
  manufacturer: string;
  uplink: string;
  ponPorts: number;
  totalOnus: number;
  onlineOnus: number;
  status: 'online' | 'offline' | 'warning';
  lastSeen: string;
}

export interface OnuDevice {
  id: string;
  serialNumber: string;
  model: string;
  oltId: string;
  oltName: string;
  ponPort: number;
  onuId: number;
  clientId: string | null;
  clientName: string | null;
  status: 'online' | 'offline' | 'unconfigured';
  rxPower: number;
  txPower: number;
  distance: number;
  firmwareVersion: string;
  lastSeen: string | null;
}
