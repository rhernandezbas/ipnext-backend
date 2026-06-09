/**
 * Read-only view of the DEPOSITO stock (EPIC #38, Wave 3). Assets are filtered
 * to status='available' in the use case; materials are all stock rows at the
 * depot. Catalog enrichment (name/label/unit) is best-effort — a missing catalog
 * row yields null fields rather than throwing.
 */
export interface DepotAssetDTO {
  id: string;
  serialNumber: string;
  mac: string | null;
  deviceTypeId: string;
  deviceTypeName: string | null;
  deviceTypeLabel: string | null;
  status: 'available';
  sourceTaskId: string | null;
}

export interface DepotMaterialDTO {
  id: string;
  materialCatalogId: string;
  name: string | null;
  label: string | null;
  unit: string | null;
  qty: number;
}

export interface DepotStockDTO {
  assets: DepotAssetDTO[];
  materials: DepotMaterialDTO[];
  depotLocationId: string | null;
}
