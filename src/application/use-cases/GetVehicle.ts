import { VehicleRepository } from '@domain/ports/VehicleRepository';
import { Vehicle } from '@domain/entities/vehicle';
import { VehicleNotFoundError } from '@domain/errors/inventory';

/**
 * Gets a single vehicle by id (EPIC #38, Wave 5b).
 */
export class GetVehicle {
  constructor(private readonly vehicles: VehicleRepository) {}

  async execute(id: string): Promise<Vehicle> {
    const vehicle = await this.vehicles.findById(id);
    if (!vehicle) throw new VehicleNotFoundError(id);
    return vehicle;
  }
}
