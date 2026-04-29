import { OltDevice, OnuDevice } from '../entities/gpon';

export interface GponRepository {
  listOlts(): Promise<OltDevice[]>;
  getOlt(id: string): Promise<OltDevice | null>;
  createOlt(data: Omit<OltDevice, 'id' | 'totalOnus' | 'onlineOnus' | 'status' | 'lastSeen'>): Promise<OltDevice>;
  listOnus(): Promise<OnuDevice[]>;
  getOnu(id: string): Promise<OnuDevice | null>;
  listOnusByOlt(oltId: string): Promise<OnuDevice[]>;
  createOnu(data: Omit<OnuDevice, 'id' | 'oltName' | 'onuId' | 'rxPower' | 'txPower' | 'distance' | 'firmwareVersion' | 'lastSeen' | 'status'>): Promise<OnuDevice>;
  updateOnuStatus(id: string, status: OnuDevice['status']): Promise<OnuDevice | null>;
}
