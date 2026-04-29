import { ServicePlan, NetworkDevice, InventoryItem, InventoryProduct, InventoryUnit } from '@domain/entities/empresa';
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

function toInventoryItem(row: any): InventoryItem {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    sku: row.sku ?? null,
    quantity: row.quantity,
    minStock: row.minStock,
    unitPrice: row.unitPrice,
    supplier: row.supplier ?? null,
    location: row.location ?? null,
    status: row.status,
  };
}

function toInventoryProduct(row: any): InventoryProduct {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    sku: row.sku ?? null,
    description: row.description ?? null,
    unitPrice: row.unitPrice,
    supplier: row.supplier ?? null,
    totalStock: row.totalStock,
    minStock: row.minStock,
    status: row.status,
  };
}

function toInventoryUnit(row: any): InventoryUnit {
  return {
    id: row.id,
    productId: row.productId,
    productName: row.product?.name ?? '',
    serialNumber: row.serialNumber ?? null,
    barcode: row.barcode ?? null,
    status: row.status,
    location: row.location ?? null,
    purchaseDate: row.purchaseDate
      ? (row.purchaseDate instanceof Date ? row.purchaseDate.toISOString().split('T')[0] : row.purchaseDate)
      : null,
    purchasePrice: row.purchasePrice ?? null,
    assignedToClientId: row.assignedToClientId ?? null,
    assignedAt: row.assignedAt
      ? (row.assignedAt instanceof Date ? row.assignedAt.toISOString() : row.assignedAt)
      : null,
    notes: row.notes ?? '',
  };
}

export class InMemoryEmpresaRepository implements EmpresaRepository {
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

  async findAllInventoryItems(): Promise<InventoryItem[]> {
    const rows = await prisma.inventoryItem.findMany();
    return rows.map(toInventoryItem);
  }

  async findInventoryItemById(id: string): Promise<InventoryItem | null> {
    const row = await prisma.inventoryItem.findUnique({ where: { id } });
    return row ? toInventoryItem(row) : null;
  }

  async createInventoryItem(data: Omit<InventoryItem, 'id'>): Promise<InventoryItem> {
    const row = await prisma.inventoryItem.create({
      data: {
        name: data.name,
        category: data.category,
        sku: data.sku ?? null,
        quantity: data.quantity,
        minStock: data.minStock,
        unitPrice: data.unitPrice,
        supplier: data.supplier ?? null,
        location: data.location ?? null,
        status: data.status,
      },
    });
    return toInventoryItem(row);
  }

  async updateInventoryItem(id: string, data: Partial<InventoryItem>): Promise<InventoryItem | null> {
    try {
      const row = await prisma.inventoryItem.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.category !== undefined && { category: data.category }),
          ...(data.sku !== undefined && { sku: data.sku }),
          ...(data.quantity !== undefined && { quantity: data.quantity }),
          ...(data.minStock !== undefined && { minStock: data.minStock }),
          ...(data.unitPrice !== undefined && { unitPrice: data.unitPrice }),
          ...(data.supplier !== undefined && { supplier: data.supplier }),
          ...(data.location !== undefined && { location: data.location }),
          ...(data.status !== undefined && { status: data.status }),
        },
      });
      return toInventoryItem(row);
    } catch {
      return null;
    }
  }

  async deleteInventoryItem(id: string): Promise<boolean> {
    try {
      await prisma.inventoryItem.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async findAllInventoryProducts(): Promise<InventoryProduct[]> {
    const rows = await prisma.inventoryProduct.findMany();
    return rows.map(toInventoryProduct);
  }

  async findInventoryProductById(id: string): Promise<InventoryProduct | null> {
    const row = await prisma.inventoryProduct.findUnique({ where: { id } });
    return row ? toInventoryProduct(row) : null;
  }

  async updateInventoryProduct(id: string, data: Partial<InventoryProduct>): Promise<InventoryProduct | null> {
    try {
      const row = await prisma.inventoryProduct.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.category !== undefined && { category: data.category }),
          ...(data.sku !== undefined && { sku: data.sku }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.unitPrice !== undefined && { unitPrice: data.unitPrice }),
          ...(data.supplier !== undefined && { supplier: data.supplier }),
          ...(data.totalStock !== undefined && { totalStock: data.totalStock }),
          ...(data.minStock !== undefined && { minStock: data.minStock }),
          ...(data.status !== undefined && { status: data.status }),
        },
      });
      return toInventoryProduct(row);
    } catch {
      return null;
    }
  }

  async deleteInventoryProduct(id: string): Promise<boolean> {
    try {
      await prisma.inventoryProduct.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async findAllInventoryUnits(): Promise<InventoryUnit[]> {
    const rows = await prisma.inventoryUnit.findMany({ include: { product: true } });
    return rows.map(toInventoryUnit);
  }

  async findInventoryUnitsByProductId(productId: string): Promise<InventoryUnit[]> {
    const rows = await prisma.inventoryUnit.findMany({
      where: { productId },
      include: { product: true },
    });
    return rows.map(toInventoryUnit);
  }

  async createInventoryUnit(data: Omit<InventoryUnit, 'id'>): Promise<InventoryUnit> {
    const row = await prisma.inventoryUnit.create({
      data: {
        productId: data.productId,
        serialNumber: data.serialNumber ?? null,
        barcode: data.barcode ?? null,
        status: data.status,
        location: data.location ?? null,
        purchaseDate: data.purchaseDate ? new Date(data.purchaseDate) : null,
        purchasePrice: data.purchasePrice ?? null,
        assignedToClientId: data.assignedToClientId ?? null,
        assignedAt: data.assignedAt ? new Date(data.assignedAt) : null,
        notes: data.notes ?? null,
      },
      include: { product: true },
    });
    return toInventoryUnit(row);
  }

  async updateInventoryUnit(id: string, data: Partial<InventoryUnit>): Promise<InventoryUnit | null> {
    try {
      const row = await prisma.inventoryUnit.update({
        where: { id },
        data: {
          ...(data.status !== undefined && { status: data.status }),
          ...(data.location !== undefined && { location: data.location }),
          ...(data.assignedToClientId !== undefined && { assignedToClientId: data.assignedToClientId }),
          ...(data.assignedAt !== undefined && {
            assignedAt: data.assignedAt ? new Date(data.assignedAt) : null,
          }),
          ...(data.notes !== undefined && { notes: data.notes }),
          ...(data.serialNumber !== undefined && { serialNumber: data.serialNumber }),
          ...(data.barcode !== undefined && { barcode: data.barcode }),
        },
        include: { product: true },
      });
      return toInventoryUnit(row);
    } catch {
      return null;
    }
  }

  async deleteInventoryUnit(id: string): Promise<boolean> {
    try {
      await prisma.inventoryUnit.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
