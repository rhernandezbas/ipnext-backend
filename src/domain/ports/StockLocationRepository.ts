import { StockLocation } from '@domain/entities/stock-location';

export interface StockLocationRepository {
  /** DEPOSITO singleton lookup by stable code. */
  findByCode(code: string): Promise<StockLocation | null>;
  /** One CLIENTE per contract. */
  findByTypeAndContract(type: string, contractId: string): Promise<StockLocation | null>;
  /** One TECNICO per technician. */
  findByTypeAndTechnician(type: string, technicianId: string): Promise<StockLocation | null>;
  create(location: StockLocation): Promise<StockLocation>;
}
