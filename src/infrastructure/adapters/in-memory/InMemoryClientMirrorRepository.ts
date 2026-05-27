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

  async upsertClient(client: GrClient): Promise<UpsertResult> {
    const created = !this.clients.has(client.grClienteId);
    this.clients.set(client.grClienteId, client);
    return { created };
  }

  async upsertContract(contract: GrContract): Promise<UpsertResult> {
    const created = !this.contracts.has(contract.grContratoId);
    this.contracts.set(contract.grContratoId, contract);
    return { created };
  }

  async updateClientBalance(grClienteId: string, amount: number, currency: string | null, at: Date): Promise<void> {
    // No-op for unknown clients (don't throw)
    this.balances.set(grClienteId, { amount, currency, lastBalanceAt: at });
  }
}
