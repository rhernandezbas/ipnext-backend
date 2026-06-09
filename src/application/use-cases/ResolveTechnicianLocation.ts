import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { StockLocation, createStockLocation } from '@domain/entities/stock-location';
import { randomUUID } from 'crypto';

/**
 * True for a DB unique-constraint violation. Detected by Prisma's `P2002` code
 * (Postgres adapter) without importing Prisma into the application layer, so the
 * use case stays adapter-agnostic. In-memory adapters that mimic the race can
 * throw an error carrying the same `code` to exercise this path.
 */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'P2002';
}

/**
 * Resuelve la ubicación TECNICO de un técnico (find-or-create idempotente,
 * keyed por (type:'TECNICO', technicianId)). Una sola TECNICO por técnico.
 * Mismo patrón que ResolveClientLocation — el find-or-create + P2002 retry.
 */
export class ResolveTechnicianLocation {
  constructor(private readonly locations: StockLocationRepository) {}

  async execute(technicianId: string): Promise<StockLocation> {
    const existing = await this.locations.findByTypeAndTechnician('TECNICO', technicianId);
    if (existing) return existing;
    try {
      return await this.locations.create(
        createStockLocation({ id: randomUUID(), type: 'TECNICO', technicianId }),
      );
    } catch (err) {
      // Fix #4 (P2002 race): two concurrent issues can both miss the find and
      // race to create the single TECNICO(technicianId). The loser hits the unique
      // constraint. Re-run the find — if the competitor's row is now visible,
      // return it (idempotent). Otherwise the error was unrelated → rethrow.
      if (isUniqueViolation(err)) {
        const winner = await this.locations.findByTypeAndTechnician('TECNICO', technicianId);
        if (winner) return winner;
      }
      throw err;
    }
  }
}
