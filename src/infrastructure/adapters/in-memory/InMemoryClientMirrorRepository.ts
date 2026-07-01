import { ClientMirrorRepository, UpsertResult } from '@domain/ports/ClientMirrorRepository';
import { GrClient, GrContract } from '@domain/entities/gestionReal';

interface BalanceRecord {
  amount: number;
  currency: string | null;
  lastBalanceAt: Date;
}

export class InMemoryClientMirrorRepository implements ClientMirrorRepository {
  clients = new Map<string, GrClient>();
  contracts = new Map<string, GrContract>();
  /** Separate balance store so catalog upserts never clobber balance data. */
  balances = new Map<string, BalanceRecord>();

  /**
   * When true, mirrors the Prisma guard: `upsertContract` returns `{ created: false }`
   * (and does NOT store the contract) when the owning client (grClienteId) is not in
   * `this.clients`. Defaults to false so existing tests that do not seed clients are unaffected.
   */
  enforceParent = false;

  async upsertClient(client: GrClient): Promise<UpsertResult> {
    const created = !this.clients.has(client.grClienteId);
    this.clients.set(client.grClienteId, client);
    return { created };
  }

  async upsertContract(contract: GrContract): Promise<UpsertResult> {
    if (this.enforceParent && !this.clients.has(contract.grClienteId)) {
      // Mirrors the Prisma guard: parent absent → skip, not update.
      return { created: false, skipped: true };
    }
    const created = !this.contracts.has(contract.grContratoId);
    this.contracts.set(contract.grContratoId, contract);
    return { created };
  }

  async updateClientBalance(grClienteId: string, amount: number, currency: string | null, at: Date): Promise<void> {
    // No-op for unknown clients (don't throw)
    this.balances.set(grClienteId, { amount, currency, lastBalanceAt: at });
  }
}
