import { ContractServiceView } from '../entities/contract-service';

export interface ContractServiceRepository {
  getById(id: string): Promise<ContractServiceView | null>;
  /** Find by the UNIQUE (contractId, serviceCatalogId) pair — duplicate pre-check. */
  getByPair(contractId: string, serviceCatalogId: string): Promise<ContractServiceView | null>;
  add(data: { contractId: string; serviceCatalogId: string; notes?: string | null; tvLogin?: string | null; tvPassword?: string | null }): Promise<ContractServiceView>;
  update(id: string, data: { status?: string; notes?: string | null; tvLogin?: string | null; tvPassword?: string | null }): Promise<ContractServiceView | null>;
  /** Returns true when a row was deleted, false when the id did not exist (idempotent caller). */
  delete(id: string): Promise<boolean>;
}
