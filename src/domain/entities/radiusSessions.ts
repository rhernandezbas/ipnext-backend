export interface RadiusSession {
  id: string;
  sessionId: string;
  clientId: string;
  clientName: string;
  nasId: string;
  nasName: string;
  ipAddress: string;
  macAddress: string;
  startedAt: string;
  duration: number;
  downloadBytes: number;
  uploadBytes: number;
  downloadMbps: number;
  uploadMbps: number;
  status: 'active' | 'idle';
  username: string;
}
