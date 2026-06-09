import { Vehicle } from '@domain/entities/vehicle';
import { VehicleRepository } from '@domain/ports/VehicleRepository';
import { prisma } from '../../database/prisma';

function toVehicle(row: any): Vehicle {
  return {
    id: row.id,
    plate: row.plate,
    name: row.name ?? null,
    assignedTechnicianId: row.assignedTechnicianId ?? null,
    status: row.status as 'active' | 'inactive',
    createdAt: row.createdAt,
  };
}

export class PrismaVehicleRepository implements VehicleRepository {
  async findById(id: string): Promise<Vehicle | null> {
    const row = await (prisma as any).vehicle.findUnique({ where: { id } });
    return row ? toVehicle(row) : null;
  }

  async findByPlate(plate: string): Promise<Vehicle | null> {
    const row = await (prisma as any).vehicle.findUnique({ where: { plate: plate.toUpperCase() } });
    return row ? toVehicle(row) : null;
  }

  async list(): Promise<Vehicle[]> {
    const rows = await (prisma as any).vehicle.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toVehicle);
  }

  async create(vehicle: Vehicle): Promise<Vehicle> {
    const row = await (prisma as any).vehicle.create({
      data: {
        id: vehicle.id,
        plate: vehicle.plate,
        name: vehicle.name,
        assignedTechnicianId: vehicle.assignedTechnicianId,
        status: vehicle.status,
      },
    });
    return toVehicle(row);
  }

  async update(
    id: string,
    patch: Partial<Pick<Vehicle, 'plate' | 'name' | 'assignedTechnicianId' | 'status'>>,
  ): Promise<Vehicle | null> {
    try {
      const row = await (prisma as any).vehicle.update({ where: { id }, data: patch });
      return toVehicle(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await (prisma as any).vehicle.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Count CAMIONETA StockLocations that reference this vehicle.
   * If count > 0, the vehicle cannot be deleted (VehicleInUseError).
   */
  async countLocationRefs(vehicleId: string): Promise<number> {
    return (prisma as any).stockLocation.count({ where: { vehicleId } });
  }
}
