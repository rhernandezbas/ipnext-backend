import { ContractInventoryRepository, ClientInstalledItemRow } from '@domain/ports/ContractInventoryRepository';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { InstalledItemNotFoundError, InstalledItemAlreadyRemovedError } from '@domain/errors/inventory';

/** Contexto de contrato registrado para el JOIN in-memory de `listByClient`. */
interface ContractContext {
  clientId: string;
  plan: string;
  type: string;
}

export class InMemoryContractInventoryRepository implements ContractInventoryRepository {
  readonly store = new Map<string, ContractInstalledItem>();
  /** Registro de contratos (contractId → contexto) para emular el JOIN con Contract. */
  private readonly contracts = new Map<string, ContractContext>();

  /**
   * Test helper: registra el contexto de un contrato para que `listByClient`
   * pueda emular el JOIN `CII ⋈ Contract WHERE clientId`. Sin esto, los items
   * de ese contrato no aparecen en la vista por cliente.
   */
  seedContract(contractId: string, ctx: ContractContext): void {
    this.contracts.set(contractId, ctx);
  }

  async listByContract(contractId: string): Promise<ContractInstalledItem[]> {
    return Array.from(this.store.values()).filter(i => i.contractId === contractId);
  }

  async listByClient(clientId: string): Promise<ClientInstalledItemRow[]> {
    const rows = Array.from(this.store.values())
      .filter(i => this.contracts.get(i.contractId)?.clientId === clientId)
      .map(i => {
        const ctx = this.contracts.get(i.contractId)!;
        return { ...i, contractPlan: ctx.plan, contractType: ctx.type };
      });
    // Ordenado por contrato y luego por antigüedad, igual que el adapter Prisma.
    return rows.sort(
      (a, b) =>
        a.contractId.localeCompare(b.contractId) || a.createdAt.localeCompare(b.createdAt),
    );
  }

  async getById(id: string): Promise<ContractInstalledItem | null> {
    const item = this.store.get(id);
    return item ? { ...item } : null;
  }

  async create(item: ContractInstalledItem): Promise<ContractInstalledItem> {
    this.store.set(item.id, item);
    return item;
  }

  async update(id: string, patch: Partial<ContractInstalledItem>): Promise<ContractInstalledItem | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id: existing.id, updatedAt: new Date().toISOString() };
    this.store.set(id, updated);
    return updated;
  }

  async remove(id: string): Promise<ContractInstalledItem | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated = { ...existing, status: 'removed' as const, updatedAt: new Date().toISOString() };
    this.store.set(id, updated);
    return { ...updated };
  }

  // service-transfer (W3) — reasigna SOLO contractId; ítem inexistente lanza (paridad Prisma).
  // Fix wave L1: CONDICIONAL a status='active' (espejo del updateMany WHERE status='active' del
  // adapter Prisma) — el retire concurrente entre la validación del caller y esta escritura
  // falla tipado en vez de mover una lápida. Objeto NUEVO en el set (invariante del snapshot
  // shallow del InMemoryUnitOfWork).
  async transferToContract(itemId: string, targetContractId: string): Promise<void> {
    const existing = this.store.get(itemId);
    if (!existing) throw new InstalledItemNotFoundError(itemId);
    if (existing.status !== 'active') throw new InstalledItemAlreadyRemovedError(itemId);
    this.store.set(itemId, { ...existing, contractId: targetContractId, updatedAt: new Date().toISOString() });
  }
}
