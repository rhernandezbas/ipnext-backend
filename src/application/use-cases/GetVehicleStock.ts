import { VehicleRepository } from '@domain/ports/VehicleRepository';
import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { MaterialStockRepository } from '@domain/ports/MaterialStockRepository';
import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { InventoryAsset } from '@domain/entities/inventory-asset';
import { MaterialStock } from '@domain/entities/material-stock';
import { DeviceTypeCatalog } from '@domain/entities/device-type-catalog';
import { MaterialCatalog } from '@domain/entities/material-catalog';
import { VehicleNotFoundError } from '@domain/errors/inventory';
import {
  VehicleStockDTO,
  VehicleAssetDTO,
  VehicleMaterialDTO,
} from '@application/dto/VehicleStockDto';

/**
 * Read-only aggregate of a vehicle's stock (EPIC #38, Wave 5b). Clone of
 * `GetTechnicianStock`, keyed by vehicle instead of technician.
 *
 * Resolves the CAMIONETA location via `findByTypeAndVehicle('CAMIONETA', id)` —
 * NEVER creates it (this is a GET; `ResolveVehicleLocation` owns the create on
 * the issue path). If the vehicle has no location the use case returns an empty
 * shape with `locationId: null` (no 404/500).
 *
 * If the vehicle does NOT exist → VehicleNotFoundError (404).
 */
export class GetVehicleStock {
  constructor(
    private readonly vehicles: VehicleRepository,
    private readonly locations: StockLocationRepository,
    private readonly assets: InventoryAssetRepository,
    private readonly materialStock: MaterialStockRepository,
    private readonly deviceTypes: DeviceTypeCatalogRepository,
    private readonly materials: MaterialCatalogRepository,
  ) {}

  async execute(vehicleId: string): Promise<VehicleStockDTO> {
    const vehicle = await this.vehicles.findById(vehicleId);
    if (!vehicle) throw new VehicleNotFoundError(vehicleId);

    const location = await this.locations.findByTypeAndVehicle('CAMIONETA', vehicleId);
    if (!location) {
      return { vehicleId, assets: [], materials: [], locationId: null };
    }

    const [rawAssets, materialRows] = await Promise.all([
      this.assets.listByLocation(location.id),
      this.materialStock.listByLocation(location.id),
    ]);

    // Filter to available only (same as GetTechnicianStock — port stays generic)
    const availableAssets = rawAssets.filter((a) => a.status === 'available');

    const [deviceTypeMap, materialMap] = await Promise.all([
      this.loadDeviceTypes(availableAssets),
      this.loadMaterials(materialRows),
    ]);

    return {
      vehicleId,
      locationId: location.id,
      assets: availableAssets.map((a) => this.toAssetDto(a, deviceTypeMap.get(a.deviceTypeId) ?? null)),
      materials: materialRows.map((m) => this.toMaterialDto(m, materialMap.get(m.materialCatalogId) ?? null)),
    };
  }

  private async loadDeviceTypes(assets: InventoryAsset[]): Promise<Map<string, DeviceTypeCatalog>> {
    const ids = [...new Set(assets.map((a) => a.deviceTypeId))];
    const rows = await Promise.all(ids.map((id) => this.deviceTypes.getById(id)));
    const map = new Map<string, DeviceTypeCatalog>();
    rows.forEach((r) => { if (r) map.set(r.id, r); });
    return map;
  }

  private async loadMaterials(stock: MaterialStock[]): Promise<Map<string, MaterialCatalog>> {
    const ids = [...new Set(stock.map((s) => s.materialCatalogId))];
    const rows = await Promise.all(ids.map((id) => this.materials.getById(id)));
    const map = new Map<string, MaterialCatalog>();
    rows.forEach((r) => { if (r) map.set(r.id, r); });
    return map;
  }

  private toAssetDto(asset: InventoryAsset, catalog: DeviceTypeCatalog | null): VehicleAssetDTO {
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

  private toMaterialDto(stock: MaterialStock, catalog: MaterialCatalog | null): VehicleMaterialDTO {
    return {
      id: stock.id,
      materialCatalogId: stock.materialCatalogId,
      name: catalog?.name ?? null,
      label: catalog?.label ?? null,
      unit: catalog?.unit ?? null,
      qty: Number(stock.qty),
    };
  }
}
