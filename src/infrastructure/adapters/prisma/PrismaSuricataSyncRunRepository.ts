import type { SuricataSyncRunRepository } from '@domain/ports/SuricataSyncRunRepository';
import type { SuricataSyncRunRecord, FinishSuricataSyncRunInput } from '@domain/entities/suricata';
import { SuricataSyncRunNotFoundError } from '@domain/errors/suricata';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value instanceof Date ? value.toISOString() : (value as string);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIsoOrNull(value: any): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): SuricataSyncRunRecord {
  return {
    id: row.id,
    startedAt: toIso(row.startedAt),
    finishedAt: toIsoOrNull(row.finishedAt),
    outcome: row.outcome,
    ticketsSeen: row.ticketsSeen,
    ticketsUpserted: row.ticketsUpserted,
    messagesUpserted: row.messagesUpserted,
    attachmentsStored: row.attachmentsStored,
    error: row.error ?? null,
    selectorMisses: row.selectorMisses ?? null,
  };
}

/**
 * suricata-tickets-mirror (Phase C, task C.5, D6.d) — Prisma adapter for
 * `SuricataSyncRunRepository`. `lastSuccessful` powers the MIRROR-1/2
 * backfill-vs-incremental watermark.
 */
export class PrismaSuricataSyncRunRepository implements SuricataSyncRunRepository {
  async start(): Promise<SuricataSyncRunRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataSyncRun.create({ data: {} });
    return toDomain(row);
  }

  async finish(id: string, input: FinishSuricataSyncRunInput): Promise<SuricataSyncRunRecord> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).suricataSyncRun.update({
        where: { id },
        data: {
          finishedAt: new Date(),
          outcome: input.outcome,
          ticketsSeen: input.ticketsSeen,
          ticketsUpserted: input.ticketsUpserted,
          messagesUpserted: input.messagesUpserted,
          attachmentsStored: input.attachmentsStored,
          error: input.error ?? null,
          selectorMisses: input.selectorMisses ?? undefined,
        },
      });
      return toDomain(row);
    } catch (e) {
      if ((e as { code?: string } | null)?.code === 'P2025') throw new SuricataSyncRunNotFoundError(id);
      throw e;
    }
  }

  /**
   * Watermark source for the incremental sweep — ONLY `outcome: 'ok'` qualifies.
   *
   * A `degraded` run finished with at least one ticket it could NOT mirror
   * (e.g. `SuricataSessionBusyError` losing the priority queue to a concurrent
   * reply). If a degraded run were allowed to be the reference point, the next
   * run's cutoff (`lastRun.startedAt`) would sit AFTER that ticket's
   * `lastMessageAt`, so the activity-descending sweep would stop before ever
   * reaching it again: the ticket (and, via the pagination `break`, everything
   * older behind it) would be abandoned permanently with no retry.
   *
   * Keeping the watermark pinned to the last genuinely `ok` run makes the next
   * run re-sweep the same window and re-attempt whatever failed. Re-sweeping is
   * cheap: D6.b's content-hash check skips the detail fetch for every ticket
   * that did succeed, so only the failed ones do real work.
   */
  async lastSuccessful(): Promise<SuricataSyncRunRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataSyncRun.findFirst({
      where: { outcome: 'ok' },
      orderBy: { finishedAt: 'desc' },
    });
    return row ? toDomain(row) : null;
  }
}
