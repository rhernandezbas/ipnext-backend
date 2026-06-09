import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { StockLocation, createStockLocation } from '@domain/entities/stock-location';
import { randomUUID } from 'crypto';

/**
 * True for a DB unique-constraint violation. Same pattern as ResolveTechnicianLocation.
 */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'P2002';
}

/**
 * Resuelve la ubicación CAMIONETA de un vehículo (find-or-create idempotente,
 * keyed por (type:'CAMIONETA', vehicleId)). Una sola CAMIONETA por vehículo.
 * Clona ResolveTechnicianLocation con CAMIONETA en lugar de TECNICO.
 */
export class ResolveVehicleLocation {
  constructor(private readonly locations: StockLocationRepository) {}

  async execute(vehicleId: string): Promise<StockLocation> {
    const existing = await this.locations.findByTypeAndVehicle('CAMIONETA', vehicleId);
    if (existing) return existing;
    try {
      return await this.locations.create(
        createStockLocation({ id: randomUUID(), type: 'CAMIONETA', vehicleId }),
      );
    } catch (err) {
      // P2002 race: two concurrent issues can both miss the find and race to create
      // the single CAMIONETA(vehicleId). The loser hits the unique constraint.
      // Re-run the find — if the competitor's row is now visible, return it (idempotent).
      // Otherwise the error was unrelated → rethrow.
      if (isUniqueViolation(err)) {
        const winner = await this.locations.findByTypeAndVehicle('CAMIONETA', vehicleId);
        if (winner) return winner;
      }
      throw err;
    }
  }
}
