import { VehicleRepository } from '@domain/ports/VehicleRepository';
import { Vehicle } from '@domain/entities/vehicle';

/**
 * Lists all vehicles in the catalog (EPIC #38, Wave 5b).
 */
export class ListVehicles {
  constructor(private readonly vehicles: VehicleRepository) {}

  async execute(): Promise<Vehicle[]> {
    return this.vehicles.list();
  }
}
