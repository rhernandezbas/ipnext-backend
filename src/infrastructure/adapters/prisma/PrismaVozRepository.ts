import { VoipCategory, VoipCdr, VoipPlan } from '@domain/entities/voz';
import { VozRepository } from '@domain/ports/VozRepository';
import { prisma } from '../../database/prisma';

function toCategory(row: any): VoipCategory {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    pricePerMinute: row.pricePerMinute,
    freeMinutes: row.freeMinutes,
    status: row.status,
  };
}

function toCdr(row: any): VoipCdr {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName,
    callerNumber: row.callerNumber,
    calledNumber: row.calledNumber,
    duration: row.duration,
    categoryId: row.categoryId ?? null,
    categoryName: row.categoryName ?? null,
    cost: row.cost,
    status: row.status,
    startedAt: row.startedAt instanceof Date ? row.startedAt.toISOString() : row.startedAt,
  };
}

function toPlan(row: any): VoipPlan {
  return {
    id: row.id,
    name: row.name,
    monthlyPrice: row.monthlyPrice,
    includedMinutes: row.includedMinutes,
    categories: row.categories as string[],
    status: row.status,
  };
}

export class InMemoryVozRepository implements VozRepository {
  async listVoipCategories(): Promise<VoipCategory[]> {
    const rows = await prisma.voipCategory.findMany();
    return rows.map(toCategory);
  }

  async createVoipCategory(data: Omit<VoipCategory, 'id'>): Promise<VoipCategory> {
    const row = await prisma.voipCategory.create({
      data: {
        name: data.name,
        prefix: data.prefix,
        pricePerMinute: data.pricePerMinute,
        freeMinutes: data.freeMinutes,
        status: data.status,
      },
    });
    return toCategory(row);
  }

  async listVoipCdrs(): Promise<VoipCdr[]> {
    const rows = await prisma.voipCdr.findMany({ orderBy: { startedAt: 'desc' } });
    return rows.map(toCdr);
  }

  async listVoipPlans(): Promise<VoipPlan[]> {
    const rows = await prisma.voipPlan.findMany();
    return rows.map(toPlan);
  }

  async createVoipPlan(data: Omit<VoipPlan, 'id'>): Promise<VoipPlan> {
    const row = await prisma.voipPlan.create({
      data: {
        name: data.name,
        monthlyPrice: data.monthlyPrice,
        includedMinutes: data.includedMinutes,
        categories: data.categories as any,
        status: data.status,
      },
    });
    return toPlan(row);
  }
}
