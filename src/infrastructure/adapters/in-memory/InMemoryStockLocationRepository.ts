import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { StockLocation, StockLocationType } from '@domain/entities/stock-location';

export class InMemoryStockLocationRepository implements StockLocationRepository {
  readonly store = new Map<string, StockLocation>();

  async findByCode(code: string): Promise<StockLocation | null> {
    const found = Array.from(this.store.values()).find((l) => l.code === code);
    return found ? { ...found } : null;
  }

  async findByTypeAndContract(type: string, contractId: string): Promise<StockLocation | null> {
    const found = Array.from(this.store.values()).find(
      (l) => l.type === type && l.contractId === contractId,
    );
    return found ? { ...found } : null;
  }

  async findByTypeAndTechnician(type: string, technicianId: string): Promise<StockLocation | null> {
    const found = Array.from(this.store.values()).find(
      (l) => l.type === type && l.technicianId === technicianId,
    );
    return found ? { ...found } : null;
  }

  async findByTypeAndVehicle(type: StockLocationType, vehicleId: string): Promise<StockLocation | null> {
    const found = Array.from(this.store.values()).find(
      (l) => l.type === type && l.vehicleId === vehicleId,
    );
    return found ? { ...found } : null;
  }

  async create(location: StockLocation): Promise<StockLocation> {
    this.store.set(location.id, { ...location });
    return { ...location };
  }
}
