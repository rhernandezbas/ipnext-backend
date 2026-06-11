/**
 * A ContractService joined with its ServiceCatalog entry — the read model returned
 * by every ContractServiceRepository operation. `name`/`label` are sourced from the
 * joined catalog row.
 */
export interface ContractServiceView {
  id: string;
  contractId: string;
  serviceCatalogId: string;
  name: string;            // from ServiceCatalog.name
  label: string | null;    // from ServiceCatalog.label
  status: string;          // active | inactive
  notes: string | null;
  createdAt: string;       // ISO 8601
}
