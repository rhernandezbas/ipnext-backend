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
   * Short, unique code for the OS used as `soCode` in IClass. Carries the task
   * sequenceNumber — UNIQUE PER OS — so the IClass OS can be correlated back to the
   * backend task. This is the MATCHING KEY for the closure loop (SO.codigo ==
   * sequenceNumber). Do NOT reuse it as the address key (#121).
   */
  soCode: string;
  /**
   * Stable code that groups Service Orders under ONE IClass address (#121).
   * For CUSTOMER tasks this is the CONTRACT (Contract.grContratoId), falling back
   * to the client code; for NETWORK tasks it is the node/city code. It must be
   * STABLE across OS of the same contract/node — never the per-OS soCode — so that
   * N OS of one contract/node share a single address in IClass instead of creating
   * one new address per OS.
   */
  addressCode: string;
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

// ── Ola A: OS action types ────────────────────────────────────────────────────

/**
 * Snapshot of a Service Order's current state in IClass.
 * Reuses the shape already parsed by `parseServiceOrderSummary`.
 * Used by the pre-check before any write action (close / assign).
 */
export interface ServiceOrderSnapshot {
  iclassId: string;
  iclassCodigo: string;
  /** Terminal statusCode is '7'. */
  statusCode: string;
  statusDescription: string;
}

/**
 * Input for closing a Service Order in IClass.
 * The adapter formats the date and builds the payload; the use case resolves all values.
 */
export interface CloseServiceOrderInput {
  /** The IClass OS code (= task.iclassOrderCode). */
  serviceOrderCode: string;
  /** Must be a valid code from the IClassResultCode catalog. */
  resultCode: string;
  /** Closure date. The adapter formats it to the IClass date format. */
  closeDate: Date;
  commentary: string;
  /** Whether the close is visible to the customer on the portal. Default: true. */
  visibleToCustomer?: boolean;
}

// ── Ola B: Team + update OS types ────────────────────────────────────────────

/**
 * A team descriptor from IClass (`GET /teams`).
 * Used by the team catalog sync and the assign-team use case.
 */
export interface IClassTeamDescriptor {
  login: string;
  name: string;
  thirdPartyCode: string | null;
}

/**
 * Input for updating a Service Order in IClass (assign team + schedule window).
 * The adapter builds the full nested soScheduleUpdateIn payload from these fields.
 */
export interface UpdateServiceOrderInput {
  /** The IClass OS code (= task.iclassOrderCode). */
  serviceOrderCode: string;
  /** The team login to assign. */
  requiredTeam: string;
  /** Schedule window start (from task.startDate). Formatted to Argentina wall-clock by the adapter. */
  scheduleStart: Date;
  /** Schedule window end (from task.endDate). Formatted to Argentina wall-clock by the adapter. */
  scheduleEnd: Date;
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

  // ── Ola A: OS write actions ───────────────────────────────────────────────

  /**
   * Fetch the current state of a Service Order from IClass for pre-check purposes.
   * Returns null when IClass responds 404 or 204 (unknown OS).
   * Passes through `withAuthRetry` (429-resilient).
   */
  getServiceOrder(iclassId: string): Promise<ServiceOrderSnapshot | null>;

  /**
   * Push a close action for a Service Order to IClass.
   * The adapter translates responses to IClassRejectedError (erros) or
   * IClassUnavailableError (5xx/timeout). Never returns on unexpected shapes.
   */
  closeServiceOrder(input: CloseServiceOrderInput): Promise<void>;

  // ── Ola B: Team + update ─────────────────────────────────────────────────

  /**
   * Fetch the team catalog from IClass (`GET /teams` filtered by thirdPartyId).
   * Maps each entry to IClassTeamDescriptor. Passes through `withAuthRetry`.
   */
  listTeams(): Promise<IClassTeamDescriptor[]>;

  /**
   * Push an update (assign team) for a Service Order to IClass.
   * Same error mapping as closeServiceOrder.
   */
  updateServiceOrder(input: UpdateServiceOrderInput): Promise<void>;
}
