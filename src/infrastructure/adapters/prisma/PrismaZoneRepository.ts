import { Zone, ZonePoint } from '@domain/entities/zone';
import { ZoneRepository, CreateZoneInput, UpdateZoneInput } from '@domain/ports/ZoneRepository';
import { prisma } from '../../database/prisma';

/**
 * PrismaZoneRepository — adapter de persistencia para Zone.
 * Usa el singleton `prisma` (patrón del proyecto, igual que PrismaPlanRepository).
 * El modelo `zone` está disponible directamente tras `prisma generate` (el Dockerfile
 * lo corre en build → en prod tipa bien; `as any` solo para el JSON `points` field).
 */
export class PrismaZoneRepository implements ZoneRepository {
  async create(input: CreateZoneInput): Promise<Zone> {
    const row = await prisma.zone.create({
      data: {
        name: input.name,
        color: input.color,
        points: input.points as any,
        description: input.description ?? null,
      },
    });
    return toEntity(row);
  }

  async findById(id: string): Promise<Zone | null> {
    const row = await prisma.zone.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async list(): Promise<Zone[]> {
    const rows = await prisma.zone.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toEntity);
  }

  async update(id: string, input: UpdateZoneInput): Promise<Zone | null> {
    try {
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data['name'] = input.name;
      if (input.color !== undefined) data['color'] = input.color;
      if (input.points !== undefined) data['points'] = input.points as any;
      if (input.description !== undefined) data['description'] = input.description;
      const row = await prisma.zone.update({ where: { id }, data: data as any });
      return toEntity(row);
    } catch (err: any) {
      if (err?.code === 'P2025') return null;
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await prisma.zone.delete({ where: { id } });
    } catch (err: any) {
      if (err?.code === 'P2025') return; // already gone — idempotent
      throw err;
    }
  }
}

function toEntity(row: any): Zone {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    points: (row.points as ZonePoint[]),
    description: row.description ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
