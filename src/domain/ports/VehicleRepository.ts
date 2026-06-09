import { Vehicle } from '@domain/entities/vehicle';

export interface VehicleRepository {
  findById(id: string): Promise<Vehicle | null>;
  findByPlate(plate: string): Promise<Vehicle | null>;
  list(): Promise<Vehicle[]>;
  create(vehicle: Vehicle): Promise<Vehicle>;
  update(id: string, patch: Partial<Pick<Vehicle, 'plate' | 'name' | 'assignedTechnicianId' | 'status'>>): Promise<Vehicle | null>;
  delete(id: string): Promise<boolean>;
  /**
   * Returns the number of CAMIONETA StockLocations (and any related stock) that
   * reference this vehicle. Used to guard deletion: if > 0, reject with VehicleInUseError.
   */
  countLocationRefs(vehicleId: string): Promise<number>;
}
