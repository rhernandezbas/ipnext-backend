import { Tr069Profile, Tr069Device } from '@domain/entities/tr069';
import { Tr069Repository } from '@domain/ports/Tr069Repository';

let nextProfileId = 4;
let nextDeviceId = 9;

export class InMemoryTr069Repository implements Tr069Repository {
  private profiles: Tr069Profile[] = [
    {
      id: '1',
      name: 'MikroTik Hogar',
      manufacturer: 'MikroTik',
      model: 'hAP ac2',
      firmwareVersion: '7.11',
      acsUrl: 'http://acs.ipnext.com.ar:7547/mikrotik',
      connectionRequestUrl: null,
      periodicInformInterval: 300,
      deviceCount: 4,
      parameters: [
        { key: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', value: '{{CLIENT_NAME}}' },
        { key: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Enable', value: 'true' },
      ],
      status: 'active',
    },
    {
      id: '2',
      name: 'Huawei ONU GPON',
      manufacturer: 'Huawei',
      model: 'HG8310M',
      firmwareVersion: 'V3R017C10S110',
      acsUrl: 'http://acs.ipnext.com.ar:7547/huawei',
      connectionRequestUrl: 'http://{{DEVICE_IP}}:30005/',
      periodicInformInterval: 600,
      deviceCount: 3,
      parameters: [
        { key: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Enable', value: 'true' },
      ],
      status: 'active',
    },
    {
      id: '3',
      name: 'FiberHome ONU Legacy',
      manufacturer: 'FiberHome',
      model: 'AN5506-02',
      firmwareVersion: null,
      acsUrl: 'http://acs.ipnext.com.ar:7547/fiberhome',
      connectionRequestUrl: null,
      periodicInformInterval: 900,
      deviceCount: 1,
      parameters: [],
      status: 'inactive',
    },
  ];

  private devices: Tr069Device[] = [
    {
      id: '1',
      serialNumber: 'MTK-001-2025',
      profileId: '1',
      profileName: 'MikroTik Hogar',
      clientId: 'c-01',
      clientName: 'Juan Pérez',
      lastContact: '2026-04-28T09:00:00Z',
      status: 'active',
      firmwareVersion: '7.11',
      parameters: [],
    },
    {
      id: '2',
      serialNumber: 'MTK-002-2025',
      profileId: '1',
      profileName: 'MikroTik Hogar',
      clientId: 'c-02',
      clientName: 'María García',
      lastContact: '2026-04-28T08:45:00Z',
      status: 'active',
      firmwareVersion: '7.11',
      parameters: [],
    },
    {
      id: '3',
      serialNumber: 'MTK-003-2025',
      profileId: '1',
      profileName: 'MikroTik Hogar',
      clientId: 'c-09',
      clientName: 'Fernando Torres',
      lastContact: '2026-04-27T20:00:00Z',
      status: 'active',
      firmwareVersion: '7.10.2',
      parameters: [],
    },
    {
      id: '4',
      serialNumber: 'MTK-004-2025',
      profileId: '1',
      profileName: 'MikroTik Hogar',
      clientId: null,
      clientName: null,
      lastContact: null,
      status: 'pending',
      firmwareVersion: '7.11',
      parameters: [],
    },
    {
      id: '5',
      serialNumber: 'HW-001-2025',
      profileId: '2',
      profileName: 'Huawei ONU GPON',
      clientId: 'c-03',
      clientName: 'Carlos López',
      lastContact: '2026-04-28T09:00:00Z',
      status: 'active',
      firmwareVersion: 'V3R017C10S110',
      parameters: [],
    },
    {
      id: '6',
      serialNumber: 'HW-002-2025',
      profileId: '2',
      profileName: 'Huawei ONU GPON',
      clientId: 'c-04',
      clientName: 'Ana Martínez',
      lastContact: '2026-04-27T18:00:00Z',
      status: 'active',
      firmwareVersion: 'V3R017C10S110',
      parameters: [],
    },
    {
      id: '7',
      serialNumber: 'HW-003-2025',
      profileId: '2',
      profileName: 'Huawei ONU GPON',
      clientId: 'c-05',
      clientName: 'Roberto Sánchez',
      lastContact: '2026-04-26T12:00:00Z',
      status: 'error',
      firmwareVersion: 'V3R017C10S100',
      parameters: [],
    },
    {
      id: '8',
      serialNumber: 'FH-001-2025',
      profileId: '3',
      profileName: 'FiberHome ONU Legacy',
      clientId: 'c-06',
      clientName: 'Laura Díaz',
      lastContact: '2026-04-25T08:00:00Z',
      status: 'error',
      firmwareVersion: 'RP2522',
      parameters: [],
    },
  ];

  async findAllProfiles(): Promise<Tr069Profile[]> {
    return [...this.profiles];
  }

  async createProfile(data: Omit<Tr069Profile, 'id'>): Promise<Tr069Profile> {
    const profile: Tr069Profile = { ...data, id: String(nextProfileId++) };
    this.profiles.push(profile);
    return profile;
  }

  async findAllDevices(): Promise<Tr069Device[]> {
    return [...this.devices];
  }

  async updateProfile(id: string, data: Partial<Tr069Profile>): Promise<Tr069Profile | null> {
    const index = this.profiles.findIndex(p => p.id === id);
    if (index === -1) return null;
    this.profiles[index] = { ...this.profiles[index], ...data };
    return this.profiles[index];
  }

  async deleteProfile(id: string): Promise<boolean> {
    const index = this.profiles.findIndex(p => p.id === id);
    if (index === -1) return false;
    this.profiles.splice(index, 1);
    return true;
  }

  async provisionDevice(id: string): Promise<Tr069Device | null> {
    const index = this.devices.findIndex(d => d.id === id);
    if (index === -1) return null;
    this.devices[index] = { ...this.devices[index], status: 'active', lastContact: new Date().toISOString() };
    return this.devices[index];
  }

  async deleteDevice(id: string): Promise<boolean> {
    const index = this.devices.findIndex(d => d.id === id);
    if (index === -1) return false;
    this.devices.splice(index, 1);
    return true;
  }
}
