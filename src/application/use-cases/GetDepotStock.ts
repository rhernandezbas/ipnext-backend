import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { MaterialStockRepository } from '@domain/ports/MaterialStockRepository';
import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { InventoryAsset } from '@domain/entities/inventory-asset';
import { MaterialStock } from '@domain/entities/material-stock';
import { DeviceTypeCatalog } from '@domain/entities/device-type-catalog';
import { MaterialCatalog } from '@domain/entities/material-catalog';
import { DepotAssetDTO, DepotMaterialDTO, DepotStockDTO } from '@application/dto/DepotStockDto';

const DEPOSITO_CODE = 'DEPOSITO';

/**
 * Read-only aggregate of the DEPOSITO stock (EPIC #38, Wave 3).
 *
 * Resolves the depot via `findByCode('DEPOSITO')` — NEVER creates it (this is a
 * GET; ResolveDepotLocation is out of scope). If the depot row is absent the
 * use case returns an empty shape with `depotLocationId: null` (no 404/500).
 *
 * Depends ONLY on port interfaces (DIP compliant). `listByLocation` is generic
 * (returns ALL assets regardless of status); THIS use case applies the
 * `status === 'available'` filter so the port stays reusable (W7 dashboard).
 */
export class GetDepotStock {
  constructor(
    private readonly locations: StockLocationRepository,
    private readonly assets: InventoryAssetRepository,
    private readonly materialStock: MaterialStockRepository,
    private readonly deviceTypes: DeviceTypeCatalogRepository,
    private readonly materials: MaterialCatalogRepository,
  ) {}

  async execute(): Promise<DepotStockDTO> {
    const depot = await this.locations.findByCode(DEPOSITO_CODE);
    if (!depot) {
      return { assets: [], materials: [], depotLocationId: null };
    }

    const [rawAssets, materialRows] = await Promise.all([
      this.assets.listByLocation(depot.id),
      this.materialStock.listByLocation(depot.id),
    ]);

    // Status filter lives HERE, not in the port (port stays generic for reuse).
    const availableAssets = rawAssets.filter((a) => a.status === 'available');

    const [deviceTypeMap, materialMap] = await Promise.all([
      this.loadDeviceTypes(availableAssets),
      this.loadMaterials(materialRows),
    ]);

    return {
      depotLocationId: depot.id,
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

  private toAssetDto(asset: InventoryAsset, catalog: DeviceTypeCatalog | null): DepotAssetDTO {
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

  private toMaterialDto(stock: MaterialStock, catalog: MaterialCatalog | null): DepotMaterialDTO {
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
