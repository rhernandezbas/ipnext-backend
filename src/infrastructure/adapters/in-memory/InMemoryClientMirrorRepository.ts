import {
  ClientMirrorRepository,
  UpdateBalanceAndInvoicesParams,
  UpsertResult,
} from '@domain/ports/ClientMirrorRepository';
import { GrClient, GrContract, GrInvoice } from '@domain/entities/gestionReal';
import { mapGrInvoice, MappedGrInvoice } from '@application/use-cases/mapGrInvoice';

interface BalanceRecord {
  amount: number;
  currency: string | null;
  lastBalanceAt: Date;
}

/** In-memory Invoice row: the mapped GR shape stamped with its owning client. */
export interface InMemoryInvoiceRecord extends Omit<MappedGrInvoice, 'grInvoiceId'> {
  /** In-memory this is the grClienteId; in Prisma it resolves to the local Client.id. */
  clientId: string;
  /** null for manual (non-GR) invoices — those are NEVER deleted by the sync. */
  grInvoiceId: string | null;
}

export class InMemoryClientMirrorRepository implements ClientMirrorRepository {
  clients = new Map<string, GrClient>();
  contracts = new Map<string, GrContract>();
  /** Separate balance store so catalog upserts never clobber balance data. */
  balances = new Map<string, BalanceRecord>();
  /** Flat invoice store (mirrors the local `Invoice` table). */
  invoices: InMemoryInvoiceRecord[] = [];

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

  /**
   * fix wave F3 — gemelo del método atómico de Prisma: **todo o nada.**
   *
   * El twin tiene que fallar IGUAL que el original, o los tests certifican una
   * atomicidad que sólo existe en memoria. Se toma un snapshot antes y se
   * restaura si cualquiera de las dos escrituras revienta — que es lo que hace
   * el rollback de Postgres, visto desde afuera.
   */
  async updateBalanceAndInvoices(params: UpdateBalanceAndInvoicesParams): Promise<void> {
    const { grClienteId, amount, currency, invoices, at } = params;
    const balancesBefore = new Map(this.balances);
    const invoicesBefore = [...this.invoices];

    try {
      await this.updateClientBalance(grClienteId, amount, currency, at);
      if (invoices !== null) {
        await this.upsertInvoices(grClienteId, invoices, at);
      }
    } catch (err) {
      this.balances = balancesBefore;
      this.invoices = invoicesBefore;
      throw err;
    }
  }

  async upsertInvoices(grClienteId: string, invoices: GrInvoice[], at: Date): Promise<void> {
    const mapped = invoices.map((inv) => mapGrInvoice(inv, at));
    const currentIds = new Set(mapped.map((m) => m.grInvoiceId));

    // Replace-all scoped to GR invoices: drop this client's GR rows GR no longer
    // returns; keep other clients and NEVER touch manual rows (grInvoiceId null).
    this.invoices = this.invoices.filter((row) => {
      if (row.clientId !== grClienteId) return true;
      if (row.grInvoiceId === null) return true;
      return currentIds.has(row.grInvoiceId);
    });

    // Upsert each current GR invoice by composite grInvoiceId.
    for (const m of mapped) {
      const idx = this.invoices.findIndex(
        (r) => r.clientId === grClienteId && r.grInvoiceId === m.grInvoiceId,
      );
      const record: InMemoryInvoiceRecord = { ...m, clientId: grClienteId };
      if (idx >= 0) this.invoices[idx] = record;
      else this.invoices.push(record);
    }
  }
}
