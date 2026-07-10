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
  /**
   * service-transfer (W3) — reasigna el ítem al contrato destino (solo `contractId`,
   * el resto de la fila queda intacto). Fix wave L1: la escritura es CONDICIONAL a
   * `status='active'` — lanza InstalledItemNotFoundError si el ítem desapareció (carrera)
   * e InstalledItemAlreadyRemovedError si dejó de estar active (el retire ganó la ventana
   * entre la validación del caller y la tx). Ambos adapters (Prisma/InMemory) comparten
   * esa semántica para que el lote atómico del use case falle igual en tests y en prod.
   */
  transferToContract(itemId: string, targetContractId: string): Promise<void>;
}
