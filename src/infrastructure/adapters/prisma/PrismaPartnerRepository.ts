import { Partner } from '@domain/entities/partner';
import { PartnerRepository } from '@domain/ports/PartnerRepository';
import { prisma } from '../../database/prisma';

function toPartner(row: any): Partner {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    primaryEmail: row.primaryEmail ?? null,
    phone: row.phone ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    country: row.country ?? null,
    timezone: row.timezone ?? null,
    currency: row.currency ?? null,
    logoUrl: row.logoUrl ?? null,
    clientCount: row.clientCount,
    adminCount: row.adminCount,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export class InMemoryPartnerRepository implements PartnerRepository {
  async findAll(): Promise<Partner[]> {
    const rows = await prisma.partner.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toPartner);
  }

  async findById(id: string): Promise<Partner | null> {
    const row = await prisma.partner.findUnique({ where: { id } });
    return row ? toPartner(row) : null;
  }

  async create(data: Omit<Partner, 'id' | 'createdAt' | 'clientCount' | 'adminCount'>): Promise<Partner> {
    const row = await prisma.partner.create({
      data: {
        name: data.name,
        status: data.status ?? 'active',
        primaryEmail: data.primaryEmail ?? null,
        phone: data.phone ?? null,
        address: data.address ?? null,
        city: data.city ?? null,
        country: data.country ?? null,
        timezone: data.timezone ?? null,
        currency: data.currency ?? null,
        logoUrl: data.logoUrl ?? null,
        clientCount: 0,
        adminCount: 0,
      },
    });
    return toPartner(row);
  }

  async update(id: string, data: Partial<Partner>): Promise<Partner | null> {
    try {
      const row = await prisma.partner.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.primaryEmail !== undefined && { primaryEmail: data.primaryEmail }),
          ...(data.phone !== undefined && { phone: data.phone }),
          ...(data.address !== undefined && { address: data.address }),
          ...(data.city !== undefined && { city: data.city }),
          ...(data.country !== undefined && { country: data.country }),
          ...(data.timezone !== undefined && { timezone: data.timezone }),
          ...(data.currency !== undefined && { currency: data.currency }),
          ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl }),
          ...(data.clientCount !== undefined && { clientCount: data.clientCount }),
          ...(data.adminCount !== undefined && { adminCount: data.adminCount }),
        },
      });
      return toPartner(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.partner.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
