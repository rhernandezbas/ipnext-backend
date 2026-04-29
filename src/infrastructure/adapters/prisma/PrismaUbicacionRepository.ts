import { Ubicacion } from '@domain/entities/ubicacion';
import { UbicacionRepository } from '@domain/ports/UbicacionRepository';
import { prisma } from '../../database/prisma';

function toUbicacion(row: any): Ubicacion {
  return {
    id: row.id,
    name: row.name,
    address: row.address ?? '',
    city: row.city ?? '',
    state: row.province ?? '',
    country: row.country,
    phone: '',
    email: '',
    manager: row.managerName ?? '',
    clientCount: row.clientCount,
    status: row.status,
    coordinates: (row.lat != null && row.lng != null)
      ? { lat: row.lat, lng: row.lng }
      : null,
    timezone: row.timezone ?? '',
  };
}

export class InMemoryUbicacionRepository implements UbicacionRepository {
  async findAll(): Promise<Ubicacion[]> {
    const rows = await prisma.ubicacion.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toUbicacion);
  }

  async findById(id: string): Promise<Ubicacion | null> {
    const row = await prisma.ubicacion.findUnique({ where: { id } });
    return row ? toUbicacion(row) : null;
  }

  async create(data: Omit<Ubicacion, 'id'>): Promise<Ubicacion> {
    const row = await prisma.ubicacion.create({
      data: {
        name: data.name,
        address: data.address ?? null,
        city: data.city ?? null,
        province: data.state ?? null,
        country: data.country ?? 'Argentina',
        lat: data.coordinates?.lat ?? null,
        lng: data.coordinates?.lng ?? null,
        status: data.status ?? 'active',
        managerName: data.manager ?? null,
        clientCount: data.clientCount ?? 0,
        timezone: data.timezone ?? null,
      },
    });
    return toUbicacion(row);
  }

  async update(id: string, data: Partial<Ubicacion>): Promise<Ubicacion | null> {
    try {
      const row = await prisma.ubicacion.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.address !== undefined && { address: data.address }),
          ...(data.city !== undefined && { city: data.city }),
          ...(data.state !== undefined && { province: data.state }),
          ...(data.country !== undefined && { country: data.country }),
          ...(data.coordinates !== undefined && {
            lat: data.coordinates?.lat ?? null,
            lng: data.coordinates?.lng ?? null,
          }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.manager !== undefined && { managerName: data.manager }),
          ...(data.clientCount !== undefined && { clientCount: data.clientCount }),
          ...(data.timezone !== undefined && { timezone: data.timezone }),
        },
      });
      return toUbicacion(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.ubicacion.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
