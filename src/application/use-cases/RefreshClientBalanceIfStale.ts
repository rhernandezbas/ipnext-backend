import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { ClientMirrorRepository } from '@domain/ports/ClientMirrorRepository';

/** Default TTL (minutes) before a balance is considered stale. Shared constant so
 * every caller of `isBalanceOlderThanTtl` (this collaborator's own gate AND
 * GetInboxClientContext's mirror-only RICH-4 default path) uses the EXACT SAME
 * default and never drifts apart. */
export const DEFAULT_BALANCE_STALE_TTL_MINUTES = 60;

/**
 * messaging-inbox-v2 (F1.5, B2) — pure staleness check, extracted out of the
 * `isStale` private method so it can be reused verbatim by GetInboxClientContext's
 * default (no-refresh) path (RICH-4): that path MUST compute `balance.stale` with
 * the SAME TTL rule as this collaborator WITHOUT invoking it (no GR call). A
 * hand-rolled duplicate of this rule in the use case would risk drifting from
 * this one if the TTL default or the comparison ever changes here.
 *
 * fix-be #6 — named `isBalanceOlderThanTtl` (not `isBalanceStale`): that name
 * collided with the private, semantically DIFFERENT `isBalanceStale` in
 * `PrismaCustomerRepository.ts` (status-aware, debtor-only — `(status, lastBalanceAt,
 * ttlMinutes)`). Same name, different signature/rule — confusing even though they
 * never actually clash at compile time (different modules).
 */
export function isBalanceOlderThanTtl(
  lastBalanceAt: string | null | undefined,
  ttlMinutes: number,
  now: () => Date,
): boolean {
  if (!lastBalanceAt) return true; // never fetched
  const ageMs = now().getTime() - new Date(lastBalanceAt).getTime();
  return ageMs > ttlMinutes * 60 * 1000;
}

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
    this.ttlMinutes = opts.ttlMinutes ?? DEFAULT_BALANCE_STALE_TTL_MINUTES;
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
    return isBalanceOlderThanTtl(lastBalanceAt, this.ttlMinutes, this.now);
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
