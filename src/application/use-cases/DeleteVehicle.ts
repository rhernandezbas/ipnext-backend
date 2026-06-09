import { VehicleRepository } from '@domain/ports/VehicleRepository';
import { VehicleNotFoundError, VehicleInUseError } from '@domain/errors/inventory';

/**
 * Deletes a Vehicle from the catalog (EPIC #38, Wave 5b).
 * Guards: findById→404; countLocationRefs>0→VehicleInUseError; else delete.
 * Clones the DeleteMaterial pattern.
 */
export class DeleteVehicle {
  constructor(private readonly vehicles: VehicleRepository) {}

  async execute(id: string): Promise<void> {
    const existing = await this.vehicles.findById(id);
    if (!existing) throw new VehicleNotFoundError(id);

    const refs = await this.vehicles.countLocationRefs(id);
    if (refs > 0) throw new VehicleInUseError(id);

    await this.vehicles.delete(id);
  }
}
