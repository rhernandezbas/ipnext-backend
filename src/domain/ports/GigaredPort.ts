/**
 * Port for the Gigared Partners API (#47).
 *
 * All shapes are camelCase — the snake_case wire representation of the Gigared API
 * (cic, gigared_id, qty_stationary_licenses, use_internal_id, …) lives ENTIRELY inside
 * the GigaredClient adapter. The application layer never sees a snake_case key.
 */

export interface GigaredService {
  id: string;
  name: string;
}

export interface GigaredOtt {
  id: string;
  stationaryLicenses: number;
  mobileLicenses: number;
  registeredDevices: number;
  status: string | null;
}

export interface GigaredAccount {
  cic: string;
  gigaredId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  registrationDate: string | null;
  services: GigaredService[];
  internalId: string | null;
  ott: GigaredOtt | null;
}

export interface GigaredPartnerService extends GigaredService {
  qtyAvailable: number;
  qtyUsed: number;
  qtyPurchased: number;
}

export interface GigaredSummary {
  accounts: { registered: number; unregistered: number; total: number };
  services: GigaredPartnerService[];
}

export interface ListAccountsFilter {
  accountId?: string;
  useInternalId?: boolean;
  email?: string;
  status?: 'registered' | 'unregistered';
  paginationLimit?: number;
  paginationOffset?: number;
}

/**
 * The application layer depends on this port; GigaredClient implements it.
 * `getAccountByInternalId` throws GigaredNotFoundError when the lookup is a 404.
 */
export interface GigaredPort {
  getSummary(): Promise<GigaredSummary>;
  listAccounts(filter?: ListAccountsFilter): Promise<GigaredAccount[]>;
  /** GET /accounts/{internalId}?use_internal_id=true — throws GigaredNotFoundError on 404. */
  getAccountByInternalId(internalId: string): Promise<GigaredAccount>;
  /** GET /accounts/{cic} (by CIC, NO use_internal_id) — throws GigaredNotFoundError on 404. */
  getAccountByCic(cic: string): Promise<GigaredAccount>;
  register(input: {
    firstName: string;
    lastName: string;
    email: string;
    cic: string;
    password: string;
    sendActivationEmail: boolean;
  }): Promise<void>;
  activate(input: { cic: string; email: string }): Promise<void>;
  setInternalId(cic: string, internalId: string): Promise<void>;
  addService(internalId: string, serviceId: string): Promise<void>;
  removeService(internalId: string, serviceId: string): Promise<void>;
  setOtt(internalId: string, enabled: boolean): Promise<void>;
}
