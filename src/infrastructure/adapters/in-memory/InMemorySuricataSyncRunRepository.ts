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

  async lastSuccessful(): Promise<SuricataSyncRunRecord | null> {
    const successful = this.rows
      .filter((r) => r.outcome === 'ok' || r.outcome === 'degraded')
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
    return successful[0] ? { ...successful[0] } : null;
  }
}
