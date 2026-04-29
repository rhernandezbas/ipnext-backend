import { CpeDevice } from '@domain/entities/cpe';
import { CpeRepository } from '@domain/ports/CpeRepository';

let nextId = 11;

export class InMemoryCpeRepository implements CpeRepository {
  private devices: CpeDevice[] = [
    {
      id: '1',
      serialNumber: 'SN-ROT-001',
      model: 'hAP ac2',
      manufacturer: 'MikroTik',
      type: 'router',
      macAddress: 'AA:BB:CC:11:22:33',
      ipAddress: '192.168.100.10',
      status: 'online',
      clientId: 'c-01',
      clientName: 'Juan Pérez',
      nasId: '1',
      networkSiteId: '1',
      firmwareVersion: '7.11',
      lastSeen: '2026-04-28T09:00:00Z',
      signal: null,
      connectedAt: '2026-04-01T08:00:00Z',
      description: 'Router hogar cliente',
    },
    {
      id: '2',
      serialNumber: 'SN-ONU-001',
      model: 'HG8310M',
      manufacturer: 'Huawei',
      type: 'onu',
      macAddress: 'AA:BB:CC:11:22:44',
      ipAddress: '192.168.100.11',
      status: 'online',
      clientId: 'c-02',
      clientName: 'María García',
      nasId: null,
      networkSiteId: '2',
      firmwareVersion: 'V3R017C10S110',
      lastSeen: '2026-04-28T09:00:00Z',
      signal: -18,
      connectedAt: '2026-03-15T10:00:00Z',
      description: 'ONU GPON cliente',
    },
    {
      id: '3',
      serialNumber: 'SN-ONT-001',
      model: 'EG8145V5',
      manufacturer: 'Huawei',
      type: 'ont',
      macAddress: 'AA:BB:CC:11:22:55',
      ipAddress: null,
      status: 'offline',
      clientId: 'c-03',
      clientName: 'Carlos López',
      nasId: null,
      networkSiteId: '2',
      firmwareVersion: 'V5R020C00S105',
      lastSeen: '2026-04-27T14:00:00Z',
      signal: null,
      connectedAt: null,
      description: 'ONT GPON hogar',
    },
    {
      id: '4',
      serialNumber: 'SN-RAD-001',
      model: 'LiteBeam 5AC',
      manufacturer: 'Ubiquiti',
      type: 'cpe_radio',
      macAddress: 'AA:BB:CC:11:22:66',
      ipAddress: '10.10.10.5',
      status: 'online',
      clientId: 'c-04',
      clientName: 'Ana Martínez',
      nasId: '2',
      networkSiteId: '3',
      firmwareVersion: '8.7.11',
      lastSeen: '2026-04-28T08:55:00Z',
      signal: -62,
      connectedAt: '2026-02-20T12:00:00Z',
      description: 'CPE radio punto a punto',
    },
    {
      id: '5',
      serialNumber: 'SN-MOD-001',
      model: 'SB8200',
      manufacturer: 'Motorola',
      type: 'modem',
      macAddress: 'AA:BB:CC:11:22:77',
      ipAddress: '192.168.200.1',
      status: 'online',
      clientId: 'c-05',
      clientName: 'Roberto Sánchez',
      nasId: '1',
      networkSiteId: '1',
      firmwareVersion: 'SB8200-4.2',
      lastSeen: '2026-04-28T09:00:00Z',
      signal: null,
      connectedAt: '2026-01-10T09:00:00Z',
      description: 'Modem cable',
    },
    {
      id: '6',
      serialNumber: 'SN-AP-001',
      model: 'UniFi AP AC Pro',
      manufacturer: 'Ubiquiti',
      type: 'ap',
      macAddress: 'AA:BB:CC:11:22:88',
      ipAddress: '10.20.1.5',
      status: 'online',
      clientId: null,
      clientName: null,
      nasId: null,
      networkSiteId: '4',
      firmwareVersion: '6.6.55',
      lastSeen: '2026-04-28T09:00:00Z',
      signal: null,
      connectedAt: '2026-04-15T07:00:00Z',
      description: 'AP interno datacenter',
    },
    {
      id: '7',
      serialNumber: 'SN-ROT-002',
      model: 'RB3011',
      manufacturer: 'MikroTik',
      type: 'router',
      macAddress: 'AA:BB:CC:11:22:99',
      ipAddress: null,
      status: 'unconfigured',
      clientId: null,
      clientName: null,
      nasId: null,
      networkSiteId: null,
      firmwareVersion: '7.10.2',
      lastSeen: null,
      signal: null,
      connectedAt: null,
      description: 'Router sin configurar',
    },
    {
      id: '8',
      serialNumber: 'SN-ONU-002',
      model: 'AN5506-02',
      manufacturer: 'FiberHome',
      type: 'onu',
      macAddress: 'AA:BB:CC:33:44:11',
      ipAddress: null,
      status: 'error',
      clientId: 'c-06',
      clientName: 'Laura Díaz',
      nasId: null,
      networkSiteId: '2',
      firmwareVersion: 'RP2522',
      lastSeen: '2026-04-27T06:00:00Z',
      signal: -35,
      connectedAt: null,
      description: 'ONU con señal degradada',
    },
    {
      id: '9',
      serialNumber: 'SN-RAD-002',
      model: 'PowerBeam 5AC',
      manufacturer: 'Ubiquiti',
      type: 'cpe_radio',
      macAddress: 'AA:BB:CC:33:44:22',
      ipAddress: '10.10.10.6',
      status: 'online',
      clientId: 'c-07',
      clientName: 'Pedro Fernández',
      nasId: '2',
      networkSiteId: '3',
      firmwareVersion: '8.7.11',
      lastSeen: '2026-04-28T08:50:00Z',
      signal: -58,
      connectedAt: '2026-03-01T11:00:00Z',
      description: 'CPE radio enlace largo alcance',
    },
    {
      id: '10',
      serialNumber: 'SN-MOD-002',
      model: 'TC4400',
      manufacturer: 'Technicolor',
      type: 'modem',
      macAddress: 'AA:BB:CC:33:44:33',
      ipAddress: null,
      status: 'offline',
      clientId: 'c-08',
      clientName: 'Silvia Romero',
      nasId: '1',
      networkSiteId: '1',
      firmwareVersion: 'STD6.02.11',
      lastSeen: '2026-04-26T15:00:00Z',
      signal: null,
      connectedAt: null,
      description: 'Modem DOCSIS 3.1',
    },
  ];

  async findAll(): Promise<CpeDevice[]> {
    return [...this.devices];
  }

  async findById(id: string): Promise<CpeDevice | null> {
    return this.devices.find(d => d.id === id) ?? null;
  }

  async create(data: Omit<CpeDevice, 'id'>): Promise<CpeDevice> {
    const device: CpeDevice = { ...data, id: String(nextId++) };
    this.devices.push(device);
    return device;
  }

  async update(id: string, data: Partial<CpeDevice>): Promise<CpeDevice | null> {
    const index = this.devices.findIndex(d => d.id === id);
    if (index === -1) return null;
    this.devices[index] = { ...this.devices[index], ...data };
    return this.devices[index];
  }

  async delete(id: string): Promise<boolean> {
    const index = this.devices.findIndex(d => d.id === id);
    if (index === -1) return false;
    this.devices.splice(index, 1);
    return true;
  }

  async assignToClient(id: string, clientId: string, clientName: string): Promise<CpeDevice | null> {
    return this.update(id, { clientId, clientName });
  }
}
