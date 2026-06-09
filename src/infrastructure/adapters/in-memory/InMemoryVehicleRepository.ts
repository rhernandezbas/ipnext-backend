import { VehicleRepository } from '@domain/ports/VehicleRepository';
import { Vehicle } from '@domain/entities/vehicle';

export class InMemoryVehicleRepository implements VehicleRepository {
  readonly store = new Map<string, Vehicle>();

  async findById(id: string): Promise<Vehicle | null> {
    const found = this.store.get(id);
    return found ? { ...found } : null;
  }

  async findByPlate(plate: string): Promise<Vehicle | null> {
    const found = Array.from(this.store.values()).find(
      (v) => v.plate.toUpperCase() === plate.toUpperCase(),
    );
    return found ? { ...found } : null;
  }

  async list(): Promise<Vehicle[]> {
    return Array.from(this.store.values()).map((v) => ({ ...v }));
  }

  async create(vehicle: Vehicle): Promise<Vehicle> {
    this.store.set(vehicle.id, { ...vehicle });
    return { ...vehicle };
  }

  async update(id: string, patch: Partial<Pick<Vehicle, 'plate' | 'name' | 'assignedTechnicianId' | 'status'>>): Promise<Vehicle | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated: Vehicle = { ...existing, ...patch };
    this.store.set(id, updated);
    return { ...updated };
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async countLocationRefs(vehicleId: string): Promise<number> {
    // In-memory: count is tracked externally (tests set it manually via a side channel).
    // Default 0 — tests that need > 0 must use a subclass or pre-populate the store.
    return this._locationRefCounts.get(vehicleId) ?? 0;
  }

  /**
   * Test helper: set the number of location refs for a vehicle.
   * Use this in tests to simulate a vehicle with existing CAMIONETA locations.
   */
  setLocationRefCount(vehicleId: string, count: number): void {
    this._locationRefCounts.set(vehicleId, count);
  }

  private readonly _locationRefCounts = new Map<string, number>();
}
