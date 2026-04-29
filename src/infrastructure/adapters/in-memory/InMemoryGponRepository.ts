import { OltDevice, OnuDevice } from '@domain/entities/gpon';
import { GponRepository } from '@domain/ports/GponRepository';

const OLTS: OltDevice[] = [
  {
    id: 'olt-1',
    name: 'OLT Central',
    ipAddress: '10.0.0.1',
    model: 'MA5800-X7',
    manufacturer: 'Huawei',
    uplink: '10 Gbps',
    ponPorts: 16,
    totalOnus: 10,
    onlineOnus: 8,
    status: 'online',
    lastSeen: '2026-04-28T07:00:00Z',
  },
  {
    id: 'olt-2',
    name: 'OLT Zona Norte',
    ipAddress: '10.0.1.1',
    model: 'OLT-G16',
    manufacturer: 'ZTE',
    uplink: '10 Gbps',
    ponPorts: 8,
    totalOnus: 10,
    onlineOnus: 7,
    status: 'online',
    lastSeen: '2026-04-28T07:00:00Z',
  },
];

function makeOnus(): OnuDevice[] {
  const onus: OnuDevice[] = [];

  // 10 ONUs for OLT Central
  for (let i = 1; i <= 10; i++) {
    const isOnline = i <= 8;
    onus.push({
      id: `onu-${i}`,
      serialNumber: `HWTC${String(i).padStart(8, '0')}`,
      model: 'HG8010H',
      oltId: 'olt-1',
      oltName: 'OLT Central',
      ponPort: Math.ceil(i / 2),
      onuId: i,
      clientId: i <= 7 ? `client-${i}` : null,
      clientName: i <= 7 ? `Cliente ${i}` : null,
      status: isOnline ? 'online' : (i === 9 ? 'offline' : 'unconfigured'),
      rxPower: isOnline ? -(15 + i * 0.8) : -35,
      txPower: 2.5,
      distance: 500 + i * 200,
      firmwareVersion: 'V300R016C10',
      lastSeen: isOnline ? '2026-04-28T07:00:00Z' : null,
    });
  }

  // 10 ONUs for OLT Zona Norte
  for (let i = 1; i <= 10; i++) {
    const isOnline = i <= 7;
    onus.push({
      id: `onu-${i + 10}`,
      serialNumber: `ZTE${String(i + 10).padStart(8, '0')}`,
      model: 'F601',
      oltId: 'olt-2',
      oltName: 'OLT Zona Norte',
      ponPort: Math.ceil(i / 2),
      onuId: i,
      clientId: i <= 6 ? `client-${i + 10}` : null,
      clientName: i <= 6 ? `Cliente Norte ${i}` : null,
      status: isOnline ? 'online' : (i === 8 ? 'offline' : 'unconfigured'),
      rxPower: isOnline ? -(16 + i * 0.9) : -35,
      txPower: 2.3,
      distance: 400 + i * 300,
      firmwareVersion: 'V1.1.10P6T14',
      lastSeen: isOnline ? '2026-04-28T07:00:00Z' : null,
    });
  }

  return onus;
}

const ONUS = makeOnus();
let nextOltId = 3;
let nextOnuId = 21;

export class InMemoryGponRepository implements GponRepository {
  private olts: OltDevice[] = [...OLTS];
  private onus: OnuDevice[] = [...ONUS];

  async listOlts(): Promise<OltDevice[]> {
    return [...this.olts];
  }

  async getOlt(id: string): Promise<OltDevice | null> {
    return this.olts.find(o => o.id === id) ?? null;
  }

  async createOlt(data: Omit<OltDevice, 'id' | 'totalOnus' | 'onlineOnus' | 'status' | 'lastSeen'>): Promise<OltDevice> {
    const olt: OltDevice = {
      id: `olt-${nextOltId++}`,
      ...data,
      totalOnus: 0,
      onlineOnus: 0,
      status: 'online',
      lastSeen: new Date().toISOString(),
    };
    this.olts.push(olt);
    return { ...olt };
  }

  async listOnus(): Promise<OnuDevice[]> {
    return [...this.onus];
  }

  async getOnu(id: string): Promise<OnuDevice | null> {
    return this.onus.find(o => o.id === id) ?? null;
  }

  async listOnusByOlt(oltId: string): Promise<OnuDevice[]> {
    return this.onus.filter(o => o.oltId === oltId);
  }

  async createOnu(data: Omit<OnuDevice, 'id' | 'oltName' | 'onuId' | 'rxPower' | 'txPower' | 'distance' | 'firmwareVersion' | 'lastSeen' | 'status'>): Promise<OnuDevice> {
    const olt = this.olts.find(o => o.id === String(data.oltId));
    const onu: OnuDevice = {
      id: `onu-${nextOnuId++}`,
      ...data,
      oltId: String(data.oltId),
      oltName: olt?.name ?? 'Unknown',
      onuId: nextOnuId - 1,
      status: 'unconfigured',
      rxPower: 0,
      txPower: 0,
      distance: 0,
      firmwareVersion: 'unknown',
      lastSeen: null,
    };
    this.onus.push(onu);
    return { ...onu };
  }

  async updateOnuStatus(id: string, status: OnuDevice['status']): Promise<OnuDevice | null> {
    const index = this.onus.findIndex(o => o.id === id);
    if (index === -1) return null;
    this.onus[index] = { ...this.onus[index], status };
    return { ...this.onus[index] };
  }
}
