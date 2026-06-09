import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

/**
 * Fila de la vista agregada por cliente: la entidad de inventario + el contexto
 * del contrato (plan y tipo) resuelto vía JOIN. No es una entidad de dominio
 * pura — es la forma cruda que devuelve `listByClient` antes de mapear a DTO.
 */
export type ClientInstalledItemRow = ContractInstalledItem & {
  contractPlan: string;
  contractType: string;
};

export interface ContractInventoryRepository {
  listByContract(contractId: string): Promise<ContractInstalledItem[]>;
  /**
   * Lista TODO el inventario instalado a lo largo de los contratos de un cliente,
   * decorando cada fila con `contractPlan`/`contractType`. Ordenado por contrato
   * (contractId asc) y luego por antigüedad (createdAt asc). Cliente sin items → [].
   */
  listByClient(clientId: string): Promise<ClientInstalledItemRow[]>;
  getById(id: string): Promise<ContractInstalledItem | null>;
  create(item: ContractInstalledItem): Promise<ContractInstalledItem>;
  update(id: string, patch: Partial<ContractInstalledItem>): Promise<ContractInstalledItem | null>;
  /** Soft-delete: status -> 'removed'. Returns the updated item, or null if not found. */
  remove(id: string): Promise<ContractInstalledItem | null>;
}
