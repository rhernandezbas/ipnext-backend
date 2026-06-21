import { Customer, Contract, ClientLog } from '../entities/customer';
import { PaginatedResult, PaginatedQuery } from '../../application/dto/pagination';

export interface ListClientsQuery extends PaginatedQuery {
  search?: string;
  status?: string;
}

export interface ListLogsQuery extends PaginatedQuery {
  clientId: string;
}

export interface CreateCustomerInput {
  name: string;
  email: string;
  phone: string;
  login: string;
  status?: 'active' | 'inactive' | 'blocked' | 'new';
  address?: string | null;
  city?: string | null;
  country?: string | null;
  splynxId?: string | null;
  customAttributes?: Record<string, unknown> | null;
}

export interface ClientStats {
  total: number;
  active: number;
  inactive: number;
  blocked: number;
  late: number;
  baja: number;
}

export interface UpdateClientLocationInput {
  lat?: number | null;
  lng?: number | null;
  plusCode?: string | null;
}

export interface CustomerRepository {
  list(query: ListClientsQuery): Promise<PaginatedResult<Customer>>;
  findById(id: string): Promise<Customer>;
  create(data: CreateCustomerInput): Promise<Customer>;
  /** Returns true when a row was deleted, false when the id did not exist. */
  delete(id: string): Promise<boolean>;
  stats(): Promise<ClientStats>;
  listContracts(clientId: string): Promise<Contract[]>;
  listInvoices(clientId: string): Promise<import('../entities/billing').Invoice[]>;
  listLogs(query: ListLogsQuery): Promise<PaginatedResult<ClientLog>>;
  /**
   * client-geolocation — update ONLY the Prominense-owned GPS fields.
   * Whitelist: lat, lng, plusCode. GR fields are NEVER touched.
   * Returns the updated Customer, or null if the id does not exist.
   */
  updateLocation(id: string, data: UpdateClientLocationInput): Promise<Customer | null>;
}
