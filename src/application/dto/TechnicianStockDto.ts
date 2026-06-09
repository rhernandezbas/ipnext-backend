/**
 * Read-only view of a technician's stock (EPIC #38, Wave 5a). Mirrors
 * `DepotStockDto` exactly: assets filtered to status='available' in the use case,
 * materials are all stock rows at the technician location, catalog enrichment is
 * best-effort (a missing catalog row yields null fields, never throws). Adds
 * `technicianId` at root for context, and `locationId` is the resolved TECNICO
 * StockLocation id (null when the technician has no location yet — no create on a GET).
 */
export interface TechnicianAssetDTO {
  id: string;
  serialNumber: string;
  mac: string | null;
  deviceTypeId: string;
  deviceTypeName: string | null;
  deviceTypeLabel: string | null;
  status: 'available';
  sourceTaskId: string | null;
}

export interface TechnicianMaterialDTO {
  id: string;
  materialCatalogId: string;
  name: string | null;
  label: string | null;
  unit: string | null;
  qty: number;
}

export interface TechnicianStockDTO {
  technicianId: string;
  assets: TechnicianAssetDTO[];
  materials: TechnicianMaterialDTO[];
  locationId: string | null;
}
