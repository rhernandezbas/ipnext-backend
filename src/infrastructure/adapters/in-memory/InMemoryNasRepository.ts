import { NasServer, RadiusConfig } from '@domain/entities/nas';
import { NasRepository } from '@domain/ports/NasRepository';

let nextNasId = 4;

export class InMemoryNasRepository implements NasRepository {
  private nasServers: NasServer[] = [
    {
      id: '1',
      name: 'MikroTik central',
      type: 'mikrotik_api',
      ipAddress: '192.168.1.1',
      radiusSecret: '••••••••',
      nasIpAddress: '192.168.1.1',
      apiPort: 8728,
      apiLogin: 'admin',
      apiPassword: '••••••••',
      status: 'active',
      lastSeen: '2026-04-28T08:00:00Z',
      clientCount: 234,
      description: 'Router central MikroTik CCR2004',
    },
    {
      id: '2',
      name: 'Ubiquiti zona norte',
      type: 'ubiquiti',
      ipAddress: '192.168.2.1',
      radiusSecret: '••••••••',
      nasIpAddress: '192.168.2.1',
      apiPort: null,
      apiLogin: null,
      apiPassword: null,
      status: 'active',
      lastSeen: '2026-04-28T07:55:00Z',
      clientCount: 89,
      description: 'Ubiquiti EdgeRouter zona norte',
    },
    {
      id: '3',
      name: 'MikroTik sucursal',
      type: 'mikrotik_radius',
      ipAddress: '10.0.0.5',
      radiusSecret: '••••••••',
      nasIpAddress: '10.0.0.5',
      apiPort: null,
      apiLogin: null,
      apiPassword: null,
      status: 'inactive',
      lastSeen: '2026-04-25T12:00:00Z',
      clientCount: 45,
      description: 'MikroTik sucursal centro',
    },
  ];

  private radiusConfig: RadiusConfig = {
    authPort: 1812,
    acctPort: 1813,
    coaPort: 3799,
    sessionTimeout: 86400,
    idleTimeout: 3600,
    interimUpdateInterval: 300,
    nasType: 'other',
    enableCoa: true,
    enableAccounting: true,
  };

  async findAllNasServers(): Promise<NasServer[]> {
    return [...this.nasServers];
  }

  async findNasServerById(id: string): Promise<NasServer | null> {
    return this.nasServers.find(n => n.id === id) ?? null;
  }

  async createNasServer(data: Omit<NasServer, 'id'>): Promise<NasServer> {
    const server: NasServer = { ...data, id: String(nextNasId++) };
    this.nasServers.push(server);
    return server;
  }

  async updateNasServer(id: string, data: Partial<NasServer>): Promise<NasServer | null> {
    const index = this.nasServers.findIndex(n => n.id === id);
    if (index === -1) return null;
    this.nasServers[index] = { ...this.nasServers[index], ...data };
    return this.nasServers[index];
  }

  async deleteNasServer(id: string): Promise<boolean> {
    const index = this.nasServers.findIndex(n => n.id === id);
    if (index === -1) return false;
    this.nasServers.splice(index, 1);
    return true;
  }

  async getRadiusConfig(): Promise<RadiusConfig> {
    return { ...this.radiusConfig };
  }

  async updateRadiusConfig(data: Partial<RadiusConfig>): Promise<RadiusConfig> {
    this.radiusConfig = { ...this.radiusConfig, ...data };
    return { ...this.radiusConfig };
  }
}
