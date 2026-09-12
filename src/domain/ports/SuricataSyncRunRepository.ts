import type { SuricataSyncRunRecord, FinishSuricataSyncRunInput } from '@domain/entities/suricata';

export interface SuricataSyncRunRepository {
  /** Creates a new row, `outcome='running'`. */
  start(): Promise<SuricataSyncRunRecord>;
  finish(id: string, input: FinishSuricataSyncRunInput): Promise<SuricataSyncRunRecord>;
  /**
   * MIRROR-1/2 — the watermark: the most recent run that mirrored EVERY ticket
   * it saw. `null` means "no reference yet", i.e. the next run backfills.
   *
   * A run qualifies when `outcome` is `ok`, or `degraded` with `error === null`.
   * The predicate is "no ticket was left unmirrored", NOT "nothing went wrong":
   *
   * - A ticket that could not be mirrored (recorded in `error`) DISQUALIFIES the
   *   run. Advancing the cutoff past it would abandon that ticket permanently,
   *   because the sweep is activity-descending (D6.a/D6.d).
   * - A selector miss does NOT disqualify it. That row still went through the
   *   mirror; only a field such as `subject` or `lastMessageAt` is incomplete.
   *   A selector breaking against third-party HTML is this scraper's expected,
   *   non-transient failure mode, so blocking on it would leave the sync in
   *   permanent backfill — re-scanning the whole backfill window every run,
   *   which can exceed the per-run page cap and REDUCE coverage. The miss stays
   *   visible through `outcome='degraded'` + `selectorMisses`.
   * - `failed` never qualifies.
   */
  lastSuccessful(): Promise<SuricataSyncRunRecord | null>;
}
