/** A node (microárea) in IClass. The node code is used as the service order's nodeCode. */
export interface IClassNode {
  code: string;
  description: string;
}

/** A Service Order type descriptor from IClass. Used by the catalog sync. */
export interface IClassSoTypeDescriptor {
  code: string;
  description: string;
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
}

/**
 * Upstream port for the IClass external API. The adapter owns auth, transport
 * and payload mapping; the application layer only sees this contract.
 */
export interface IClassPort {
  listNodes(): Promise<IClassNode[]>;
  /**
   * Returns the catalog of SO types available for the configured thirdParty.
   * Used by SyncIClassSoTypeCatalog.
   */
  listServiceOrderTypes(): Promise<IClassSoTypeDescriptor[]>;
  createServiceOrder(input: CreateServiceOrderInput): Promise<{ orderCode: string }>;
}
