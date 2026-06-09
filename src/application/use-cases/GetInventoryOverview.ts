import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { StockLocationType } from '@domain/entities/stock-location';
import {
  InventoryOverviewDTO,
  OverviewGroupDTO,
} from '@application/dto/InventoryOverviewDto';

const ALL_TYPES: StockLocationType[] = ['DEPOSITO', 'CLIENTE', 'TECNICO', 'CAMIONETA'];

/**
 * Wave 7 (Capstone) — GET /api/inventory/overview/locations.
 *
 * Groups all locations with content by type. ALL 4 types are always present
 * in the response — empty groups have count 0. Labels are resolved in the
 * adapter (one Prisma pass, no N+1).
 */
export class GetInventoryOverview {
  constructor(private readonly locationRepo: StockLocationRepository) {}

  async execute(): Promise<InventoryOverviewDTO> {
    const locations = await this.locationRepo.listWithContent();

    const groups: OverviewGroupDTO[] = ALL_TYPES.map((type) => {
      const matching = locations.filter((l) => l.type === type);
      return {
        type,
        locationCount: matching.length,
        totalAssets: matching.reduce((sum, l) => sum + l.assetCount, 0),
        totalMaterialQty: matching.reduce((sum, l) => sum + l.materialQty, 0),
        locations: matching.map((l) => ({
          locationId: l.id,
          label: l.label,
          assetCount: l.assetCount,
          materialQty: l.materialQty,
        })),
      };
    });

    return { groups };
  }
}
