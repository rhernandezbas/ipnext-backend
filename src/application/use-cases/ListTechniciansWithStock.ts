import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { StockLocationRepository } from '@domain/ports/StockLocationRepository';

/** Login of the GR-ingest system bootstrap user — excluded from operator-facing lists. */
const SYSTEM_USER_LOGINS = new Set(['api']);

/**
 * Technician summary entry — FE wire contract (FIX B).
 * Always present for every active user; `assetCount` and `materialQty` are 0
 * when the user has no TECNICO stock location (or the location is empty).
 */
export interface TechnicianStockSummaryDto {
  id: string;
  name: string;
  assetCount: number;
  materialQty: number;
}

/**
 * Returns all active technicians (all active RbacUsers) with their TECNICO
 * stock summary (`assetCount`, `materialQty`). Users with no TECNICO location
 * OR an empty location show 0s.
 *
 * NO N+1: one `users.list()` pass + one `locations.listWithContent()` pass —
 * content is aggregated from the locations' `assetCount` / `materialQty` fields
 * that Prisma already materialises in one query (mirrors W7 listWithContent pattern).
 *
 * Result is ordered by name ASC (FE contract).
 */
export class ListTechniciansWithStock {
  constructor(
    private readonly users: RbacUserRepository,
    private readonly locations: StockLocationRepository,
  ) {}

  async execute(): Promise<TechnicianStockSummaryDto[]> {
    const [allUsers, allLocations] = await Promise.all([
      this.users.list(),
      this.locations.listWithContent(),
    ]);

    // Index TECNICO locations by technicianId — one per technician.
    const stockMap = new Map<string, { assetCount: number; materialQty: number }>();
    for (const loc of allLocations) {
      if (loc.type !== 'TECNICO' || !loc.technicianId) continue;
      stockMap.set(loc.technicianId, {
        assetCount: loc.assetCount,
        materialQty: loc.materialQty,
      });
    }

    const result: TechnicianStockSummaryDto[] = allUsers
      .filter((u) => u.status === 'active' && !SYSTEM_USER_LOGINS.has(u.login))
      .map((u) => {
        const stock = stockMap.get(u.id);
        return {
          id: u.id,
          name: u.name,
          assetCount: stock?.assetCount ?? 0,
          materialQty: stock?.materialQty ?? 0,
        };
      });

    // Sort by name ASC (FE contract).
    result.sort((a, b) => a.name.localeCompare(b.name));

    return result;
  }
}
