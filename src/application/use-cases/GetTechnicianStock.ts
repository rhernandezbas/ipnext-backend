import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { MaterialStockRepository } from '@domain/ports/MaterialStockRepository';
import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { InventoryAsset } from '@domain/entities/inventory-asset';
import { MaterialStock } from '@domain/entities/material-stock';
import { DeviceTypeCatalog } from '@domain/entities/device-type-catalog';
import { MaterialCatalog } from '@domain/entities/material-catalog';
import {
  TechnicianAssetDTO,
  TechnicianMaterialDTO,
  TechnicianStockDTO,
} from '@application/dto/TechnicianStockDto';

const TECNICO_TYPE = 'TECNICO';

/**
 * Read-only aggregate of a technician's stock (EPIC #38, Wave 5a). Clone of
 * `GetDepotStock`, keyed by technician instead of the depot singleton.
 *
 * Resolves the TECNICO location via `findByTypeAndTechnician('TECNICO', id)` —
 * NEVER creates it (this is a GET; `ResolveTechnicianLocation` owns the create on
 * the issue path). If the technician has no location the use case returns an empty
 * shape with `locationId: null` (no 404/500).
 *
 * Depends ONLY on port interfaces (DIP compliant). `listByLocation` is generic
 * (returns ALL assets regardless of status); THIS use case applies the
 * `status === 'available'` filter so the port stays reusable.
 */
export class GetTechnicianStock {
  constructor(
    private readonly locations: StockLocationRepository,
    private readonly assets: InventoryAssetRepository,
    private readonly materialStock: MaterialStockRepository,
    private readonly deviceTypes: DeviceTypeCatalogRepository,
    private readonly materials: MaterialCatalogRepository,
  ) {}

  async execute(technicianId: string): Promise<TechnicianStockDTO> {
    const location = await this.locations.findByTypeAndTechnician(TECNICO_TYPE, technicianId);
    if (!location) {
      return { technicianId, assets: [], materials: [], locationId: null };
    }

    const [rawAssets, materialRows] = await Promise.all([
      this.assets.listByLocation(location.id),
      this.materialStock.listByLocation(location.id),
    ]);

    // Status filter lives HERE, not in the port (port stays generic for reuse).
    const availableAssets = rawAssets.filter((a) => a.status === 'available');

    const [deviceTypeMap, materialMap] = await Promise.all([
      this.loadDeviceTypes(availableAssets),
      this.loadMaterials(materialRows),
    ]);

    return {
      technicianId,
      locationId: location.id,
      assets: availableAssets.map((a) => this.toAssetDto(a, deviceTypeMap.get(a.deviceTypeId) ?? null)),
      materials: materialRows.map((m) => this.toMaterialDto(m, materialMap.get(m.materialCatalogId) ?? null)),
    };
  }

  private async loadDeviceTypes(assets: InventoryAsset[]): Promise<Map<string, DeviceTypeCatalog>> {
    const ids = [...new Set(assets.map((a) => a.deviceTypeId))];
    const rows = await Promise.all(ids.map((id) => this.deviceTypes.getById(id)));
    const map = new Map<string, DeviceTypeCatalog>();
    rows.forEach((r) => {
      if (r) map.set(r.id, r);
    });
    return map;
  }

  private async loadMaterials(stock: MaterialStock[]): Promise<Map<string, MaterialCatalog>> {
    const ids = [...new Set(stock.map((s) => s.materialCatalogId))];
    const rows = await Promise.all(ids.map((id) => this.materials.getById(id)));
    const map = new Map<string, MaterialCatalog>();
    rows.forEach((r) => {
      if (r) map.set(r.id, r);
    });
    return map;
  }

  private toAssetDto(asset: InventoryAsset, catalog: DeviceTypeCatalog | null): TechnicianAssetDTO {
    return {
      id: asset.id,
      serialNumber: asset.serialNumber,
      mac: asset.mac,
      deviceTypeId: asset.deviceTypeId,
      deviceTypeName: catalog?.name ?? null,
      deviceTypeLabel: catalog?.label ?? null,
      status: 'available',
      sourceTaskId: asset.sourceTaskId,
    };
  }

  private toMaterialDto(stock: MaterialStock, catalog: MaterialCatalog | null): TechnicianMaterialDTO {
    return {
      id: stock.id,
      materialCatalogId: stock.materialCatalogId,
      name: catalog?.name ?? null,
      label: catalog?.label ?? null,
      unit: catalog?.unit ?? null,
      qty: stock.qty,
    };
  }
}
