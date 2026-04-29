import { NasServer, RadiusConfig } from '@domain/entities/nas';
import { NasRepository } from '@domain/ports/NasRepository';
import { prisma } from '../../database/prisma';

function toNasServer(row: any): NasServer {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    ipAddress: row.ipAddress,
    radiusSecret: row.radiusSecret ?? null,
    nasIpAddress: row.nasIpAddress ?? null,
    apiPort: row.apiPort ?? null,
    apiLogin: row.apiLogin ?? null,
    apiPassword: row.apiPassword ?? null,
    status: row.status,
    lastSeen: row.lastSeen
      ? (row.lastSeen instanceof Date ? row.lastSeen.toISOString() : row.lastSeen)
      : null,
    clientCount: row.clientCount,
    description: row.description ?? null,
  };
}

function toRadiusConfig(row: any): RadiusConfig {
  return {
    authPort: row.authPort,
    acctPort: row.acctPort,
    coaPort: row.coaPort,
    sessionTimeout: row.sessionTimeout,
    idleTimeout: row.idleTimeout,
    interimUpdateInterval: row.interimUpdateInterval,
    nasType: row.nasType,
    enableCoa: row.enableCoa,
    enableAccounting: row.enableAccounting,
  };
}

export class InMemoryNasRepository implements NasRepository {
  async findAllNasServers(): Promise<NasServer[]> {
    const rows = await prisma.nasServer.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toNasServer);
  }

  async findNasServerById(id: string): Promise<NasServer | null> {
    const row = await prisma.nasServer.findUnique({ where: { id } });
    return row ? toNasServer(row) : null;
  }

  async createNasServer(data: Omit<NasServer, 'id'>): Promise<NasServer> {
    const row = await prisma.nasServer.create({
      data: {
        name: data.name,
        type: data.type,
        ipAddress: data.ipAddress,
        radiusSecret: data.radiusSecret ?? null,
        nasIpAddress: data.nasIpAddress ?? null,
        apiPort: data.apiPort ?? null,
        apiLogin: data.apiLogin ?? null,
        apiPassword: data.apiPassword ?? null,
        status: data.status ?? 'active',
        lastSeen: data.lastSeen ? new Date(data.lastSeen) : null,
        clientCount: data.clientCount ?? 0,
        description: data.description ?? null,
      },
    });
    return toNasServer(row);
  }

  async updateNasServer(id: string, data: Partial<NasServer>): Promise<NasServer | null> {
    try {
      const row = await prisma.nasServer.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.type !== undefined && { type: data.type }),
          ...(data.ipAddress !== undefined && { ipAddress: data.ipAddress }),
          ...(data.radiusSecret !== undefined && { radiusSecret: data.radiusSecret }),
          ...(data.nasIpAddress !== undefined && { nasIpAddress: data.nasIpAddress }),
          ...(data.apiPort !== undefined && { apiPort: data.apiPort }),
          ...(data.apiLogin !== undefined && { apiLogin: data.apiLogin }),
          ...(data.apiPassword !== undefined && { apiPassword: data.apiPassword }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.lastSeen !== undefined && {
            lastSeen: data.lastSeen ? new Date(data.lastSeen) : null,
          }),
          ...(data.clientCount !== undefined && { clientCount: data.clientCount }),
          ...(data.description !== undefined && { description: data.description }),
        },
      });
      return toNasServer(row);
    } catch {
      return null;
    }
  }

  async deleteNasServer(id: string): Promise<boolean> {
    try {
      await prisma.nasServer.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async getRadiusConfig(): Promise<RadiusConfig> {
    let row = await prisma.radiusConfig.findUnique({ where: { id: 'singleton' } });
    if (!row) {
      row = await prisma.radiusConfig.create({ data: { id: 'singleton' } });
    }
    return toRadiusConfig(row);
  }

  async updateRadiusConfig(data: Partial<RadiusConfig>): Promise<RadiusConfig> {
    const row = await prisma.radiusConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...data } as any,
      update: data as any,
    });
    return toRadiusConfig(row);
  }
}
