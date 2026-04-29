import { Lead, LeadStatus, LeadSource } from '@domain/entities/lead';
import { LeadRepository } from '@domain/ports/LeadRepository';
import { prisma } from '../../database/prisma';
import { LeadStatus as PrismaLeadStatus } from '@prisma/client';

// Domain uses 'new', Prisma enum uses 'new_lead' mapped to DB value 'new'
function toPrismaStatus(status: LeadStatus): PrismaLeadStatus {
  if (status === 'new') return PrismaLeadStatus.new_lead;
  return status as PrismaLeadStatus;
}

function fromPrismaStatus(status: PrismaLeadStatus): LeadStatus {
  if (status === PrismaLeadStatus.new_lead) return 'new';
  return status as LeadStatus;
}

function toLead(row: any): Lead {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? '',
    phone: row.phone ?? '',
    address: row.address ?? '',
    city: row.city ?? '',
    source: row.source as LeadSource,
    status: fromPrismaStatus(row.status),
    assignedTo: row.assignedTo ?? '',
    assignedToId: row.assignedToId ?? '',
    interestedIn: row.interestedIn ?? '',
    notes: row.notes ?? '',
    followUpDate: row.followUpDate
      ? (row.followUpDate instanceof Date ? row.followUpDate.toISOString().split('T')[0] : row.followUpDate)
      : null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    convertedAt: row.convertedAt
      ? (row.convertedAt instanceof Date ? row.convertedAt.toISOString() : row.convertedAt)
      : null,
    convertedClientId: row.convertedClientId ?? null,
  };
}

export class InMemoryLeadRepository implements LeadRepository {
  async findAll(): Promise<Lead[]> {
    const rows = await prisma.lead.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(toLead);
  }

  async findById(id: string): Promise<Lead | null> {
    const row = await prisma.lead.findUnique({ where: { id } });
    return row ? toLead(row) : null;
  }

  async create(data: Omit<Lead, 'id' | 'createdAt' | 'convertedAt' | 'convertedClientId'>): Promise<Lead> {
    const row = await prisma.lead.create({
      data: {
        name: data.name,
        email: data.email || null,
        phone: data.phone || null,
        address: data.address || null,
        city: data.city || null,
        source: data.source as any,
        status: toPrismaStatus(data.status),
        assignedTo: data.assignedTo || null,
        assignedToId: data.assignedToId || null,
        interestedIn: data.interestedIn || null,
        notes: data.notes || null,
        followUpDate: data.followUpDate ? new Date(data.followUpDate) : null,
      },
    });
    return toLead(row);
  }

  async update(id: string, data: Partial<Lead>): Promise<Lead | null> {
    try {
      const row = await prisma.lead.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.email !== undefined && { email: data.email || null }),
          ...(data.phone !== undefined && { phone: data.phone || null }),
          ...(data.address !== undefined && { address: data.address || null }),
          ...(data.city !== undefined && { city: data.city || null }),
          ...(data.source !== undefined && { source: data.source as any }),
          ...(data.status !== undefined && { status: toPrismaStatus(data.status) }),
          ...(data.assignedTo !== undefined && { assignedTo: data.assignedTo || null }),
          ...(data.assignedToId !== undefined && { assignedToId: data.assignedToId || null }),
          ...(data.interestedIn !== undefined && { interestedIn: data.interestedIn || null }),
          ...(data.notes !== undefined && { notes: data.notes || null }),
          ...(data.followUpDate !== undefined && {
            followUpDate: data.followUpDate ? new Date(data.followUpDate) : null,
          }),
          ...(data.convertedAt !== undefined && {
            convertedAt: data.convertedAt ? new Date(data.convertedAt) : null,
          }),
          ...(data.convertedClientId !== undefined && { convertedClientId: data.convertedClientId }),
        },
      });
      return toLead(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.lead.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async convertToClient(id: string, clientId: string): Promise<Lead | null> {
    return this.update(id, {
      status: 'won',
      convertedAt: new Date().toISOString(),
      convertedClientId: clientId,
    });
  }
}
