import { VehicleRepository } from '@domain/ports/VehicleRepository';
import { Vehicle } from '@domain/entities/vehicle';
import { DuplicatePlateError } from '@domain/errors/inventory';
import { randomUUID } from 'crypto';

export interface CreateVehicleInput {
  plate: string;
  name?: string | null;
  assignedTechnicianId?: string | null;
}

/**
 * Creates a new Vehicle in the catalog (EPIC #38, Wave 5b).
 * Validates plate uniqueness (case-insensitive), then delegates to the repo.
 * Clones the MaterialCatalog pattern.
 */
export class CreateVehicle {
  constructor(private readonly vehicles: VehicleRepository) {}

  async execute(input: CreateVehicleInput): Promise<Vehicle> {
    const plate = input.plate.trim().toUpperCase();
    const existing = await this.vehicles.findByPlate(plate);
    if (existing) throw new DuplicatePlateError(plate);
    return this.vehicles.create({
      id: randomUUID(),
      plate,
      name: input.name ?? null,
      assignedTechnicianId: input.assignedTechnicianId ?? null,
      status: 'active',
      createdAt: new Date(),
    });
  }
}
