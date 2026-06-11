import {
  ClosedServiceOrderSummary,
  SoStatusHistoryEntry,
  SoChecklist,
  SoMaterial,
  SoEquipmentEvent,
} from '@domain/entities/iclass-closed-order';

/** A node (microárea) descriptor from IClass. The node code is used as the service order's nodeCode. */
export interface IClassNodeDescriptor {
  /** IClass node id — stable unique key, used as the upsert key by the catalog sync. */
  nodeId: number;
  code: string;
  description: string;
}

/** A Service Order type descriptor from IClass. Used by the catalog sync. */
export interface IClassSoTypeDescriptor {
  code: string;
  description: string;
}

/** A result-code descriptor from IClass (`/serviceordertypes/{id}/resultcodes`). */
export interface IClassResultCodeDescriptor {
  /** Owning SO type id (string-encoded BigInt). */
  soTypeId: string | null;
  /** Result-code name — equals motivoFechamento on a closed SO. */
  code: string;
  /** Sucesso | Falha | ... */
  type: string;
}

/** Parameters for the closed-SO list query (cluster + date window). */
export interface ListServiceOrdersParams {
  /** Lower bound of the updatedDate window. */
  updatedDateBegin: Date;
  /** Upper bound of the updatedDate window. */
  updatedDateEnd: Date;
  /** Optional exact `serviceOrderCode` filter — used by the per-task backfill reconcile. */
  serviceOrderCode?: string;
}

/**
 * Input to create a Service Order in IClass. The adapter performs an inline
 * upsert of customer + address, so all fields the OS needs travel together.
 */
export interface CreateServiceOrderInput {
  /**
   * Short, unique code for the OS used as soCode/addressCode in IClass. Carries the
   * task sequenceNumber so the IClass OS can be correlated back to the backend task.
   */
  soCode: string;
  /** Backend client id (upsert inline in IClass as customerCode). */
  customerCode: string;
  customerName: string;
  phone: string;
  address: string;
  /** Used as the address nodeCode (resolves the microárea). */
  city: string;
  description: string;
  /**
   * typeSOSummary for IClass. Resolved by the caller from project.iclassSoType.code.
   * Required — the adapter is a "dumb transport" and does NOT resolve this itself (AD-2).
   */
  soType: string;
  /**
   * Override del nodeCode (microárea). Cuando viene, el adapter usa este valor
   * como address.nodeCode en vez de derivarlo de `city` (default).
   * Lo setea el reenvio manual (ResendTaskToIClassWithNode). Aditivo y backward-compatible.
   */
  nodeCode?: string;
}

/**
 * Upstream port for the IClass external API. The adapter owns auth, transport
 * and payload mapping; the application layer only sees this contract.
 */
export interface IClassPort {
  listNodes(): Promise<IClassNodeDescriptor[]>;
  /**
   * Returns the catalog of SO types available for the configured thirdParty.
   * Used by SyncIClassSoTypeCatalog.
   */
  listServiceOrderTypes(): Promise<IClassSoTypeDescriptor[]>;
  createServiceOrder(input: CreateServiceOrderInput): Promise<{ orderCode: string }>;

  // ── Closure loop (read path) ──────────────────────────────────────────────

  /**
   * List service orders for the configured cluster within the updatedDate window
   * (and optional serviceOrderCode). Returns normalized summaries; the caller
   * filters to terminal status ('7'). The adapter paginates internally.
   */
  listServiceOrders(params: ListServiceOrdersParams): Promise<ClosedServiceOrderSummary[]>;
  /** Status timeline for one SO (`/serviceorders/{id}/history`). Empty when 204. */
  getServiceOrderHistory(iclassId: string): Promise<SoStatusHistoryEntry[]>;
  /** Checklists for one SO (`/serviceorders/{id}/checklist`). Empty when 204. */
  getServiceOrderChecklists(iclassId: string): Promise<SoChecklist[]>;
  /** Materials for one SO (`/serviceorders/{id}/materials`). Empty when 204. */
  getServiceOrderMaterials(iclassId: string): Promise<SoMaterial[]>;
  /** Equipment events for one SO (`/serviceorders/{id}/equipments/history`). Empty when 204. */
  getServiceOrderEquipmentEvents(iclassId: string): Promise<SoEquipmentEvent[]>;
  /** All result codes across SO types — for the result-code catalog sync. */
  listResultCodes(): Promise<IClassResultCodeDescriptor[]>;
}
