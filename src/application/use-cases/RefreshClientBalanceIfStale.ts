import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { ClientMirrorRepository } from '@domain/ports/ClientMirrorRepository';

export interface RefreshClientBalanceIfStaleOptions {
  now?: () => Date;
  /** TTL in minutes before a balance is considered stale. Default: 60. */
  ttlMinutes?: number;
  /** Max ms to wait for GR before falling back to stored value. Default: 4000. */
  timeoutMs?: number;
}

export interface RefreshInput {
  /** GR client id — null if the client has no GR link (no call will be made). */
  grClienteId: string | null | undefined;
  /** ISO timestamp of the last balance fetch, or null if never fetched. */
  lastBalanceAt: string | null | undefined;
}

/**
 * On-demand stale check collaborator for GetClientDetail.
 *
 * Called INSIDE the request handler for a debtor. If the balance is stale
 * (null or older than TTL), it attempts a live fetchClientBalance with a
 * short timeout. On success, persists and returns true. On GR error or timeout,
 * swallows the error and returns false (the caller falls back to the stored value
 * with balanceStale:true). Never throws.
 *
 * DIP-clean: depends only on ports, never on Prisma or the adapter.
 */
export class RefreshClientBalanceIfStale {
  private readonly now: () => Date;
  private readonly ttlMinutes: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly gr: GestionRealPort,
    private readonly mirror: ClientMirrorRepository,
    opts: RefreshClientBalanceIfStaleOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.ttlMinutes = opts.ttlMinutes ?? 60;
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  /**
   * Returns true when a fresh balance was fetched and stored; false otherwise
   * (not stale, no grClienteId, or GR failed).
   */
  async execute(input: RefreshInput): Promise<boolean> {
    const { grClienteId, lastBalanceAt } = input;
    if (!grClienteId) return false;
    if (!this.isStale(lastBalanceAt)) return false;

    try {
      const at = this.now();
      const balance = await this.withTimeout(this.gr.fetchClientBalance(grClienteId), this.timeoutMs);
      await this.mirror.updateClientBalance(grClienteId, balance.amount, balance.currency, at);
      // Sync the client's GR invoices from the SAME payload (zero extra GR calls).
      // Guard (review #1): debt reported (amount > 0) but no itemized invoices ⇒ the list
      // is non-authoritative (schema drift / partial payload); a blind replace-all would
      // wipe the mirror. Sync only when authoritative: non-empty, or genuine zero-debt.
      if (balance.invoices.length > 0 || balance.amount <= 0) {
        await this.mirror.upsertInvoices(grClienteId, balance.invoices, at);
      }
      return true;
    } catch {
      // Swallow — caller will serve stored value with balanceStale:true
      return false;
    }
  }

  private isStale(lastBalanceAt: string | null | undefined): boolean {
    if (!lastBalanceAt) return true; // never fetched
    const ageMs = this.now().getTime() - new Date(lastBalanceAt).getTime();
    return ageMs > this.ttlMinutes * 60 * 1000;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`GR timeout after ${ms}ms`)), ms);
      promise.then(
        v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e); },
      );
    });
  }
}
