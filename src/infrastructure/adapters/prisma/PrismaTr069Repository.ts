import { Tr069Profile, Tr069Device } from '@domain/entities/tr069';
import { Tr069Repository } from '@domain/ports/Tr069Repository';
import { prisma } from '../../database/prisma';

function toProfile(row: any): Tr069Profile {
  const config = (row.config as any) ?? {};
  return {
    id: row.id,
    name: row.name,
    manufacturer: config.manufacturer ?? '',
    model: config.model ?? '',
    firmwareVersion: config.firmwareVersion ?? null,
    acsUrl: config.acsUrl ?? '',
    connectionRequestUrl: config.connectionRequestUrl ?? null,
    periodicInformInterval: config.periodicInformInterval ?? 300,
    deviceCount: 0,
    parameters: config.parameters ?? [],
    status: row.status,
  };
}

function toDevice(row: any): Tr069Device {
  return {
    id: row.id,
    serialNumber: row.deviceId ?? '',
    profileId: row.profileId ?? '',
    profileName: row.profile?.name ?? '',
    clientId: row.clientId ?? null,
    clientName: row.clientName ?? null,
    lastContact: row.lastProvisioned
      ? (row.lastProvisioned instanceof Date ? row.lastProvisioned.toISOString() : row.lastProvisioned)
      : null,
    status: row.status,
    firmwareVersion: '',
    parameters: [],
  };
}

export class InMemoryTr069Repository implements Tr069Repository {
  async findAllProfiles(): Promise<Tr069Profile[]> {
    const rows = await prisma.tr069Profile.findMany();
    return rows.map(toProfile);
  }

  async createProfile(data: Omit<Tr069Profile, 'id'>): Promise<Tr069Profile> {
    const row = await prisma.tr069Profile.create({
      data: {
        name: data.name,
        manufacturerModel: data.model ?? null,
        description: data.firmwareVersion ?? null,
        config: {
          manufacturer: data.manufacturer,
          model: data.model,
          firmwareVersion: data.firmwareVersion,
          acsUrl: data.acsUrl,
          connectionRequestUrl: data.connectionRequestUrl,
          periodicInformInterval: data.periodicInformInterval,
          parameters: data.parameters,
        },
        status: data.status ?? 'active',
      },
    });
    return toProfile(row);
  }

  async findAllDevices(): Promise<Tr069Device[]> {
    const rows = await prisma.tr069Device.findMany({
      include: { profile: { select: { name: true } } },
    });
    return rows.map(toDevice);
  }

  async updateProfile(id: string, data: Partial<Tr069Profile>): Promise<Tr069Profile | null> {
    try {
      const existing = await prisma.tr069Profile.findUnique({ where: { id } });
      if (!existing) return null;
      const existingConfig = (existing.config as any) ?? {};
      const row = await prisma.tr069Profile.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.status !== undefined && { status: data.status }),
          config: {
            ...existingConfig,
            ...(data.manufacturer !== undefined && { manufacturer: data.manufacturer }),
            ...(data.model !== undefined && { model: data.model }),
            ...(data.firmwareVersion !== undefined && { firmwareVersion: data.firmwareVersion }),
            ...(data.acsUrl !== undefined && { acsUrl: data.acsUrl }),
            ...(data.connectionRequestUrl !== undefined && { connectionRequestUrl: data.connectionRequestUrl }),
            ...(data.periodicInformInterval !== undefined && { periodicInformInterval: data.periodicInformInterval }),
            ...(data.parameters !== undefined && { parameters: data.parameters }),
          },
        },
      });
      return toProfile(row);
    } catch {
      return null;
    }
  }

  async deleteProfile(id: string): Promise<boolean> {
    try {
      await prisma.tr069Profile.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async provisionDevice(id: string): Promise<Tr069Device | null> {
    try {
      const row = await prisma.tr069Device.update({
        where: { id },
        data: { status: 'active', lastProvisioned: new Date() },
        include: { profile: { select: { name: true } } },
      });
      return toDevice(row);
    } catch {
      return null;
    }
  }

  async deleteDevice(id: string): Promise<boolean> {
    try {
      await prisma.tr069Device.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
