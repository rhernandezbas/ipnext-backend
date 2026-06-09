/**
 * VehicleStockDTO — mirrors TechnicianStockDTO with root `vehicleId` instead of
 * `technicianId`. Assets are filtered to `status === 'available'` in the use case.
 * Missing catalog rows yield null fields (never throws).
 */
export interface VehicleAssetDTO {
  id: string;
  serialNumber: string;
  mac: string | null;
  deviceTypeId: string;
  deviceTypeName: string | null;
  deviceTypeLabel: string | null;
  status: 'available';
  sourceTaskId: string | null;
}

export interface VehicleMaterialDTO {
  id: string;
  materialCatalogId: string;
  name: string | null;
  label: string | null;
  unit: string | null;
  qty: number;
}

export interface VehicleStockDTO {
  vehicleId: string;
  assets: VehicleAssetDTO[];
  materials: VehicleMaterialDTO[];
  locationId: string | null;
}
