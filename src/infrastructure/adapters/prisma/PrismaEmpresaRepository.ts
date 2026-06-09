import { ServicePlan, NetworkDevice } from '@domain/entities/empresa';
import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { prisma } from '../../database/prisma';

function toServicePlan(row: any): ServicePlan {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    planSubtype: row.planSubtype ?? null,
    downloadSpeed: row.downloadSpeed ?? 0,
    uploadSpeed: row.uploadSpeed ?? 0,
    price: row.price,
    billingCycle: row.billingCycle,
    status: row.status,
    description: row.description ?? null,
    subscriberCount: row.subscriberCount,
  };
}

function toNetworkDevice(row: any): NetworkDevice {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    ipAddress: row.ipAddress ?? null,
    macAddress: row.macAddress ?? null,
    location: row.location ?? null,
    status: row.status,
    model: row.model ?? null,
    lastSeen: row.lastSeen
      ? (row.lastSeen instanceof Date ? row.lastSeen.toISOString() : row.lastSeen)
      : null,
  };
}

export class PrismaEmpresaRepository implements EmpresaRepository {
  async findAllServicePlans(subtype?: string): Promise<ServicePlan[]> {
    const rows = await prisma.servicePlan.findMany({
      where: subtype ? { planSubtype: subtype } : undefined,
    });
    return rows.map(toServicePlan);
  }

  async findServicePlanById(id: string): Promise<ServicePlan | null> {
    const row = await prisma.servicePlan.findUnique({ where: { id } });
    return row ? toServicePlan(row) : null;
  }

  async createServicePlan(data: Omit<ServicePlan, 'id'>): Promise<ServicePlan> {
    const row = await prisma.servicePlan.create({
      data: {
        name: data.name,
        type: data.type,
        planSubtype: data.planSubtype ?? null,
        downloadSpeed: data.downloadSpeed ?? null,
        uploadSpeed: data.uploadSpeed ?? null,
        price: data.price,
        billingCycle: data.billingCycle,
        status: data.status,
        description: data.description ?? null,
        subscriberCount: data.subscriberCount ?? 0,
      },
    });
    return toServicePlan(row);
  }

  async updateServicePlan(id: string, data: Partial<ServicePlan>): Promise<ServicePlan | null> {
    try {
      const row = await prisma.servicePlan.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.type !== undefined && { type: data.type }),
          ...(data.planSubtype !== undefined && { planSubtype: data.planSubtype }),
          ...(data.downloadSpeed !== undefined && { downloadSpeed: data.downloadSpeed }),
          ...(data.uploadSpeed !== undefined && { uploadSpeed: data.uploadSpeed }),
          ...(data.price !== undefined && { price: data.price }),
          ...(data.billingCycle !== undefined && { billingCycle: data.billingCycle }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.subscriberCount !== undefined && { subscriberCount: data.subscriberCount }),
        },
      });
      return toServicePlan(row);
    } catch {
      return null;
    }
  }

  async deleteServicePlan(id: string): Promise<boolean> {
    try {
      await prisma.servicePlan.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async findAllNetworkDevices(): Promise<NetworkDevice[]> {
    const rows = await prisma.networkDevice.findMany();
    return rows.map(toNetworkDevice);
  }

  async findNetworkDeviceById(id: string): Promise<NetworkDevice | null> {
    const row = await prisma.networkDevice.findUnique({ where: { id } });
    return row ? toNetworkDevice(row) : null;
  }

  async createNetworkDevice(data: Omit<NetworkDevice, 'id'>): Promise<NetworkDevice> {
    const row = await prisma.networkDevice.create({
      data: {
        name: data.name,
        type: data.type,
        ipAddress: data.ipAddress ?? null,
        macAddress: data.macAddress ?? null,
        location: data.location ?? null,
        status: data.status,
        model: data.model ?? null,
        lastSeen: data.lastSeen ? new Date(data.lastSeen) : null,
      },
    });
    return toNetworkDevice(row);
  }

  async updateNetworkDevice(id: string, data: Partial<NetworkDevice>): Promise<NetworkDevice | null> {
    try {
      const row = await prisma.networkDevice.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.type !== undefined && { type: data.type }),
          ...(data.ipAddress !== undefined && { ipAddress: data.ipAddress }),
          ...(data.macAddress !== undefined && { macAddress: data.macAddress }),
          ...(data.location !== undefined && { location: data.location }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.model !== undefined && { model: data.model }),
          ...(data.lastSeen !== undefined && {
            lastSeen: data.lastSeen ? new Date(data.lastSeen) : null,
          }),
        },
      });
      return toNetworkDevice(row);
    } catch {
      return null;
    }
  }

  async deleteNetworkDevice(id: string): Promise<boolean> {
    try {
      await prisma.networkDevice.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

}
