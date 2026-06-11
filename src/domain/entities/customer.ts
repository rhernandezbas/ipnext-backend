export type CustomerStatus = 'active' | 'late' | 'blocked' | 'inactive' | 'baja';

export interface Customer {
  id: string;
  /** External Gestión Real client id, when this row came from the GR mirror. */
  grClienteId?: string | null;
  name: string;
  email: string;
  phone: string;
  status: CustomerStatus;
  address: string;
  city: string;
  country: string;
  login: string;
  createdAt: string;
  customAttributes?: Record<string, string>;
  // GR balance fields
  /** Outstanding debt amount (ARS). 0 = no debt, null = never fetched. */
  balanceDue?: number | null;
  /** Currency code, e.g. "ARS". Null until first fetch. */
  balanceCurrency?: string | null;
  /** ISO timestamp of the last balance refresh. */
  lastBalanceAt?: string | null;
  /** True when the balance is older than the TTL or has never been fetched (and client is a debtor). */
  balanceStale?: boolean;
}

/**
 * A ContractService as embedded in a Contract's `services[]` array (spec CSV-4.1).
 * Note: NO `contractId` — the owning contract is implicit.
 */
export interface ContractServiceItem {
  id: string;
  serviceCatalogId: string;
  name: string;            // from ServiceCatalog.name
  label: string | null;    // from ServiceCatalog.label
  status: string;          // active | inactive
  notes: string | null;
  createdAt: string;       // ISO 8601
}

export interface Contract {
  id: string;
  type: string;
  plan: string;
  ip: string;
  status: string;
  startDate: string;
  endDate: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  /** #43 manual-only identifier. null for GR-synced contracts with no manual name. */
  name: string | null;
  /** #43 eager-loaded services for this contract. Empty array when none. */
  services: ContractServiceItem[];
}

export interface ClientLog {
  id: string;
  timestamp: string;
  eventType: string;
  description: string;
}

export interface ClientComment {
  id: string;
  clientId: string;
  authorName: string;
  content: string;
  createdAt: string;
}
