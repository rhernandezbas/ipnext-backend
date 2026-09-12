import { randomUUID } from 'crypto';
import type { SuricataSyncRunRepository } from '@domain/ports/SuricataSyncRunRepository';
import type { SuricataSyncRunRecord, FinishSuricataSyncRunInput } from '@domain/entities/suricata';
import { SuricataSyncRunNotFoundError } from '@domain/errors/suricata';

/** In-memory `SuricataSyncRunRepository` for use-case tests. */
export class InMemorySuricataSyncRunRepository implements SuricataSyncRunRepository {
  private rows: SuricataSyncRunRecord[] = [];

  async start(): Promise<SuricataSyncRunRecord> {
    const row: SuricataSyncRunRecord = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outcome: 'running',
      ticketsSeen: 0,
      ticketsUpserted: 0,
      messagesUpserted: 0,
      attachmentsStored: 0,
      error: null,
      selectorMisses: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async finish(id: string, input: FinishSuricataSyncRunInput): Promise<SuricataSyncRunRecord> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new SuricataSyncRunNotFoundError(id);
    row.finishedAt = new Date().toISOString();
    row.outcome = input.outcome;
    row.ticketsSeen = input.ticketsSeen;
    row.ticketsUpserted = input.ticketsUpserted;
    row.messagesUpserted = input.messagesUpserted;
    row.attachmentsStored = input.attachmentsStored;
    row.error = input.error ?? null;
    row.selectorMisses = input.selectorMisses ?? null;
    return { ...row };
  }

  /**
   * The watermark reference is a run that mirrored EVERY ticket it saw: `ok`,
   * or `degraded` with no ticket-level failure (`error === null`).
   *
   * What must block: a ticket that was never mirrored. Advancing the cutoff
   * past it abandons it permanently, so any run that recorded one (`error !==
   * null`, and every `failed` run) is excluded.
   *
   * What must NOT block: a selector miss. That row WAS mirrored, only with an
   * incomplete field, and a broken selector against third-party HTML is the
   * expected (non-transient) failure mode here — blocking on it would pin the
   * sync in permanent backfill. It still shows up as `degraded`/`selectorMisses`.
   *
   * Mirrors `PrismaSuricataSyncRunRepository.lastSuccessful`.
   */
  async lastSuccessful(): Promise<SuricataSyncRunRecord | null> {
    const successful = this.rows
      .filter((r) => r.outcome === 'ok' || (r.outcome === 'degraded' && r.error === null))
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
    return successful[0] ? { ...successful[0] } : null;
  }
}
