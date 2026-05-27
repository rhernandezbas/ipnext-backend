/** A node (microárea) in IClass. The node code is used as the service order's nodeCode. */
export interface IClassNode {
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
}

/**
 * Upstream port for the IClass external API. The adapter owns auth, transport
 * and payload mapping; the application layer only sees this contract.
 */
export interface IClassPort {
  listNodes(): Promise<IClassNode[]>;
  createServiceOrder(input: CreateServiceOrderInput): Promise<{ orderCode: string }>;
}
