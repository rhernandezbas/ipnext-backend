export interface MonitoringDevice {
  id: string;
  name: string;
  type: 'nas' | 'cpe' | 'site' | 'onu';
  ipAddress: string;
  status: 'online' | 'offline' | 'warning' | 'unknown';
  coordinates: { lat: number; lng: number };
  nasId: string | null;
  clientId: string | null;
  clientName: string | null;
  lastSeen: string | null;
  uptimePercent: number;
  latency: number | null;       // ms
  downloadMbps: number | null;
  uploadMbps: number | null;
  alertCount: number;
}

export interface MonitoringAlert {
  id: string;
  deviceId: string;
  deviceName: string;
  type: 'offline' | 'high_latency' | 'packet_loss' | 'bandwidth_exceeded' | 'config_changed';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  occurredAt: string;
  resolvedAt: string | null;
  acknowledged: boolean;
}

export interface MonitoringStats {
  totalDevices: number;
  onlineDevices: number;
  offlineDevices: number;
  warningDevices: number;
  activeAlerts: number;
  criticalAlerts: number;
  avgLatency: number;
  avgUptimePercent: number;
}
