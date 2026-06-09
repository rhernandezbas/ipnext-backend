import { VehicleRepository } from '@domain/ports/VehicleRepository';
import { Vehicle } from '@domain/entities/vehicle';
import { VehicleNotFoundError, DuplicatePlateError } from '@domain/errors/inventory';

export interface UpdateVehicleInput {
  plate?: string;
  name?: string | null;
  assignedTechnicianId?: string | null;
  status?: 'active' | 'inactive';
}

/**
 * Patches a Vehicle (EPIC #38, Wave 5b). Finds by id, applies partial patch.
 * If plate changes, checks uniqueness to avoid duplicates.
 */
export class UpdateVehicle {
  constructor(private readonly vehicles: VehicleRepository) {}

  async execute(id: string, input: UpdateVehicleInput): Promise<Vehicle> {
    const existing = await this.vehicles.findById(id);
    if (!existing) throw new VehicleNotFoundError(id);

    const patch: Partial<Pick<Vehicle, 'plate' | 'name' | 'assignedTechnicianId' | 'status'>> = {};

    if (input.plate !== undefined) {
      const plate = input.plate.trim().toUpperCase();
      if (plate !== existing.plate) {
        const conflict = await this.vehicles.findByPlate(plate);
        if (conflict) throw new DuplicatePlateError(plate);
      }
      patch.plate = input.plate.trim().toUpperCase();
    }
    if (input.name !== undefined) patch.name = input.name;
    if (input.assignedTechnicianId !== undefined) patch.assignedTechnicianId = input.assignedTechnicianId;
    if (input.status !== undefined) patch.status = input.status;

    const updated = await this.vehicles.update(id, patch);
    if (!updated) throw new VehicleNotFoundError(id);
    return updated;
  }
}
