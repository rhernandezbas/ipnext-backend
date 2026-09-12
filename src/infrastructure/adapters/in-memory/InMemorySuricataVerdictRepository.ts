import { randomUUID } from 'crypto';
import type { SuricataVerdictRepository } from '@domain/ports/SuricataVerdictRepository';
import type { SuricataVerdictRecord, CreateSuricataVerdictInput } from '@domain/entities/suricata';

/**
 * In-memory `SuricataVerdictRepository` for use-case tests (Phase D, D9).
 * `create` ALWAYS pushes a new row — there is no update path, enforcing the
 * append-only contract (VERDICT-4) at the adapter level too, not just by
 * convention in the use case.
 */
export class InMemorySuricataVerdictRepository implements SuricataVerdictRepository {
  private rows: SuricataVerdictRecord[] = [];

  constructor(private readonly opts: { now?: () => Date } = {}) {}

  async create(input: CreateSuricataVerdictInput): Promise<SuricataVerdictRecord> {
    const row: SuricataVerdictRecord = {
      id: randomUUID(),
      ticketId: input.ticketId,
      resuelto: input.resuelto,
      analisis: input.analisis,
      motivo: input.motivo,
      respuestaSugerida: input.respuestaSugerida,
      ticketContentHash: input.ticketContentHash,
      submittedBy: input.submittedBy,
      createdAt: (this.opts.now?.() ?? new Date()).toISOString(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async listByTicket(ticketId: string): Promise<SuricataVerdictRecord[]> {
    return this.rows.filter((r) => r.ticketId === ticketId).map((r) => ({ ...r }));
  }

  async latestByTicket(ticketId: string): Promise<SuricataVerdictRecord | null> {
    const rows = this.rows.filter((r) => r.ticketId === ticketId);
    if (rows.length === 0) return null;
    // `Array.prototype.sort` is stable in Node — equal `createdAt` (fast tests
    // running within the same millisecond) keeps INSERTION order, so the last
    // element after an ascending sort is always the most recently created one.
    const sorted = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { ...sorted[sorted.length - 1] };
  }

  async latestByTicketIds(ticketIds: string[]): Promise<Map<string, SuricataVerdictRecord>> {
    const wanted = new Set(ticketIds);
    const result = new Map<string, SuricataVerdictRecord>();
    // Same stable-sort-then-reduce trick as `latestByTicket` — ascending order,
    // last write per ticketId wins.
    const sorted = [...this.rows]
      .filter((r) => wanted.has(r.ticketId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const row of sorted) {
      result.set(row.ticketId, { ...row });
    }
    return result;
  }
}
