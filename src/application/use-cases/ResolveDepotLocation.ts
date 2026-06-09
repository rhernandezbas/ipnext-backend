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
 * Resuelve el singleton DEPOSITO por code (find-or-create idempotente).
 * Si no existe, lo crea. Llamadas repetidas devuelven la misma ubicación.
 */
export class ResolveDepotLocation {
  constructor(private readonly locations: StockLocationRepository) {}

  async execute(code = 'DEPOSITO'): Promise<StockLocation> {
    const existing = await this.locations.findByCode(code);
    if (existing) return existing;
    try {
      return await this.locations.create(
        createStockLocation({ id: randomUUID(), type: 'DEPOSITO', code }),
      );
    } catch (err) {
      // Fix #4 (P2002 race): two concurrent confirms (W2/W4) can both miss the
      // find and race to create the single DEPOSITO(code). The loser hits the
      // unique constraint. Re-run the find — if the competitor's row is now
      // visible, return it (idempotent). Otherwise the error was unrelated →
      // rethrow.
      if (isUniqueViolation(err)) {
        const winner = await this.locations.findByCode(code);
        if (winner) return winner;
      }
      throw err;
    }
  }
}
