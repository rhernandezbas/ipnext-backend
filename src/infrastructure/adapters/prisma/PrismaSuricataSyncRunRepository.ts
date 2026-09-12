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
   * Watermark source for the incremental sweep — the last run that mirrored
   * EVERY ticket it saw: `outcome: 'ok'`, or `degraded` with `error IS NULL`.
   *
   * BLOCKS the watermark: a ticket that could NOT be mirrored (e.g.
   * `SuricataSessionBusyError` losing the priority queue to a concurrent
   * reply). `SyncSuricataTickets` records exactly those in `error`. If such a
   * run were the reference point, the next run's cutoff (`lastRun.startedAt`)
   * would sit AFTER that ticket's `lastMessageAt`, so the activity-descending
   * sweep would stop before ever reaching it again: the ticket (and, via the
   * pagination `break`, everything older behind it) would be abandoned
   * permanently with no retry. Pinning the watermark instead makes the next run
   * re-sweep the same window. Re-sweeping is cheap: D6.b's content-hash check
   * skips the detail fetch for every ticket that did succeed.
   *
   * Does NOT block the watermark: a selector miss (D6.d invariant 2). That row
   * went through `syncOneTicket` and IS mirrored — only a field like `subject`
   * or `lastMessageAt` is incomplete — and a selector breaking against
   * third-party HTML is this scraper's EXPECTED failure mode, not a transient
   * one. Blocking on it would leave the sync in permanent backfill, re-scanning
   * the whole `SURICATA_BACKFILL_DAYS` window on every run forever, which can
   * exceed `SURICATA_MAX_PAGES_PER_RUN` and REDUCE coverage instead of
   * protecting it. The miss stays visible via `outcome='degraded'` +
   * `selectorMisses`.
   */
  async lastSuccessful(): Promise<SuricataSyncRunRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataSyncRun.findFirst({
      where: { OR: [{ outcome: 'ok' }, { outcome: 'degraded', error: null }] },
      orderBy: { finishedAt: 'desc' },
    });
    return row ? toDomain(row) : null;
  }
}
