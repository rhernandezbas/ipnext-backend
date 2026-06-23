export type RadiusEventType = 'start' | 'stop' | 'interim';

export interface RadiusEvent {
  id: string;
  sourceUniqueId: string;
  username: string;
  nasIpAddress: string;
  nasId: string | null;
  framedIp: string | null;
  macAddress: string | null;
  vlanId: number | null;
  startedAt: string;       // ISO 8601
  stoppedAt: string | null;
  sessionTime: number | null;
  bytesIn: bigint;
  bytesOut: bigint;
  eventType: RadiusEventType;
  status: string;          // 'online' | 'closed' — denormalized for indexed filter
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
}
