import { createHash } from 'crypto';
import type {
  SuricataScraperPort,
  SuricataTicketSummary,
  SuricataScrapedAttachmentRef,
} from '@domain/ports/SuricataScraperPort';
import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { SuricataMessageRepository } from '@domain/ports/SuricataMessageRepository';
import type { SuricataAttachmentRepository } from '@domain/ports/SuricataAttachmentRepository';
import type { SuricataAreaRepository } from '@domain/ports/SuricataAreaRepository';
import type { SuricataSyncRunRepository } from '@domain/ports/SuricataSyncRunRepository';
import type { FileStorage } from '@domain/ports/FileStorage';
import type { SuricataMessageRecord, SuricataSyncRunRecord } from '@domain/entities/suricata';
import { computeSuricataContentHash } from '@domain/entities/suricataContentHash';

/** Molde MEDIA-3 / D6.b — abandon an attachment after this many failed download attempts. */
const MAX_ATTACHMENT_ATTEMPTS = 5;

export interface SyncSuricataTicketsConfig {
  /** D6.a — first-run backfill window, in days. */
  backfillDays: number;
  /** D6.a — hard page cap per run (both backfill and incremental). */
  maxPagesPerRun: number;
  /** D7.b — per-attachment ceiling; over this, the row is `failed`/`lastError='too_large'`. */
  maxAttachmentBytes: number;
}

interface SyncOneTicketResult {
  ticketUpserted: boolean;
  messagesUpserted: number;
  attachmentsStored: number;
}

/**
 * SyncSuricataTickets (suricata-tickets-mirror, Phase C, tasks C.6/C.7/C.8) —
 * background sync: backfill/incremental ticket+message+attachment mirror plus
 * area catalog refresh (design D0/D6/D7). Read-only against Suricata
 * (MIRROR-8): `SuricataScraperPort` has no write method at all, so this class
 * cannot mutate the remote system through it even by mistake.
 *
 * D6.b's performance rule ("si el hash no cambió, no se abre el detalle") is
 * why `SuricataTicketSummary` (the LIST view) already carries every field
 * `computeSuricataContentHash` needs — a ticket is only re-fetched via
 * `scraper.getTicket` when the hash actually differs from what's stored.
 */
export class SyncSuricataTickets {
  constructor(
    private readonly scraper: SuricataScraperPort,
    private readonly tickets: SuricataTicketRepository,
    private readonly messages: SuricataMessageRepository,
    private readonly attachments: SuricataAttachmentRepository,
    private readonly areas: SuricataAreaRepository,
    private readonly syncRuns: SuricataSyncRunRepository,
    private readonly fileStorage: FileStorage,
    private readonly cfg: SyncSuricataTicketsConfig,
  ) {}

  async execute(): Promise<SuricataSyncRunRecord> {
    const run = await this.syncRuns.start();
    const nowIso = new Date().toISOString();

    let ticketsSeen = 0;
    let ticketsUpserted = 0;
    let messagesUpserted = 0;
    let attachmentsStored = 0;
    const selectorMisses: string[] = [];
    const failedTicketExternalIds: string[] = [];

    try {
      // D6.c — area catalog: full refresh every run, soft-delete only, never a hard delete.
      const scrapedAreas = await this.scraper.listAreas();
      await this.areas.upsertMany(scrapedAreas.map((a) => ({ externalId: a.externalId, name: a.name, syncedAt: nowIso })));
      await this.areas.deactivateMissing(scrapedAreas.map((a) => a.externalId));

      // `lastSuccessful()` reports the last run that closed `ok` — a
      // `degraded` run is deliberately NOT a reference point, because it left
      // at least one ticket unmirrored and advancing past it would abandon
      // that ticket forever (see `PrismaSuricataSyncRunRepository`).
      const lastRun = await this.syncRuns.lastSuccessful();
      const isBackfill = !lastRun;
      // Watermark = the PREVIOUS run's start (not finish) so a ticket touched
      // WHILE that run was in flight is never silently skipped on this run.
      const watermark = lastRun?.startedAt ?? null;
      const backfillCutoff = isBackfill
        ? new Date(Date.now() - this.cfg.backfillDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

      let page = 1;
      let stop = false;

      while (!stop && page <= this.cfg.maxPagesPerRun) {
        const pageResult = await this.scraper.listTicketPage(page);

        if (page === 1 && pageResult.tickets.length === 0) {
          // D6.d invariant 1 — a 200 response with ZERO tickets on page 1 means
          // the selector is broken, not "no tickets". Fail loudly, write
          // nothing about tickets (the area refresh above is D6.c's own
          // independent full-catalog behavior, unaffected by this invariant).
          return this.syncRuns.finish(run.id, {
            outcome: 'failed',
            ticketsSeen: 0,
            ticketsUpserted: 0,
            messagesUpserted: 0,
            attachmentsStored: 0,
            error: 'Suricata ticket list page 1 returned zero tickets on a successful response -- selector likely broken (D6.d)',
          });
        }

        // The `stop = true; break` below is an EARLY EXIT that relies on D6.a:
        // the Suricata list is ordered by activity DESCENDING, so the first row
        // at/below the cutoff means every remaining row is older too. Two
        // reasons this stays safe rather than skipping live tickets behind an
        // old one:
        //   1. Ordering is part of the PORT contract
        //      (`SuricataScraperPort.listTicketPage`: "1-indexed, ordered by
        //      activity descending (D6.a)"), so any adapter that cannot honour
        //      it is the thing to fix, not this loop. Residual: that ordering
        //      is asserted on the port, not verified against the live Suricata
        //      DOM — if the real list ever comes back unordered, this early
        //      exit under-reads a page (D14 smoke is where that would surface).
        //   2. Under-reading is recoverable, not lossy: a skipped ticket keeps
        //      its old/absent `contentHash`, and the cutoff can only ever
        //      regress to the last `ok` run, so a later run re-sweeps the same
        //      window instead of losing the ticket permanently.
        for (const summary of pageResult.tickets) {
          if (isBackfill && backfillCutoff && summary.lastMessageAt && summary.lastMessageAt < backfillCutoff) {
            stop = true;
            break;
          }
          if (!isBackfill && watermark && summary.lastMessageAt && summary.lastMessageAt <= watermark) {
            stop = true;
            break;
          }

          ticketsSeen += 1;

          if (!summary.subject || !summary.lastMessageAt) {
            // D6.d invariant 2 — a required field missing on an otherwise-parsed
            // row: recorded, never thrown.
            selectorMisses.push(summary.externalId);
          }

          try {
            const result = await this.syncOneTicket(summary, nowIso);
            if (result.ticketUpserted) ticketsUpserted += 1;
            messagesUpserted += result.messagesUpserted;
            attachmentsStored += result.attachmentsStored;
          } catch (err) {
            // MIRROR-4 — isolate the failing ticket, keep going. Its
            // `contentHash` was never updated, so the NEXT run's list-vs-stored
            // comparison sees it as changed again and retries it -- the
            // scheduler's tick interval IS the backoff (molde
            // ChatMediaDownloadScheduler / D6.b).
            failedTicketExternalIds.push(summary.externalId);
            console.error(`[suricata-sync] ticket ${summary.externalId} failed: ${(err as Error).message}`);
          }
        }

        if (stop || !pageResult.hasNextPage) break;
        page += 1;
      }

      const outcome: 'ok' | 'degraded' =
        selectorMisses.length > 0 || failedTicketExternalIds.length > 0 ? 'degraded' : 'ok';
      const error =
        failedTicketExternalIds.length > 0
          ? `${failedTicketExternalIds.length} ticket(s) failed to sync: ${failedTicketExternalIds.join(', ')}`
          : null;

      return this.syncRuns.finish(run.id, {
        outcome,
        ticketsSeen,
        ticketsUpserted,
        messagesUpserted,
        attachmentsStored,
        error,
        selectorMisses: selectorMisses.length > 0 ? selectorMisses : null,
      });
    } catch (err) {
      // MIRROR-5 — an unresolved error ends the run visibly; whatever was
      // already persisted by prior successful runs (or earlier in THIS loop)
      // is left exactly as-is -- this only records the run's own outcome.
      return this.syncRuns.finish(run.id, {
        outcome: 'failed',
        ticketsSeen,
        ticketsUpserted,
        messagesUpserted,
        attachmentsStored,
        error: (err as Error).message,
        selectorMisses: selectorMisses.length > 0 ? selectorMisses : null,
      });
    }
  }

  /** D6.b — upsert-if-changed; returns false (no writes) when the hash matches what's stored. */
  private async syncOneTicket(summary: SuricataTicketSummary, nowIso: string): Promise<SyncOneTicketResult> {
    const contentHash = computeSuricataContentHash({
      subject: summary.subject,
      status: summary.status,
      priority: summary.priority,
      areaExternalId: summary.areaExternalId,
      lastMessageAt: summary.lastMessageAt,
      messageCount: summary.messageCount,
    });

    const existing = await this.tickets.findByExternalId(summary.externalId);
    if (existing && existing.contentHash === contentHash) {
      return { ticketUpserted: false, messagesUpserted: 0, attachmentsStored: 0 };
    }

    const detail = await this.scraper.getTicket(summary.externalId);
    const area = detail.areaExternalId ? await this.areas.findByExternalId(detail.areaExternalId) : null;

    const ticket = await this.tickets.upsertByExternalId({
      externalId: detail.externalId,
      subject: detail.subject,
      status: detail.status,
      priority: detail.priority,
      areaId: area?.id ?? null,
      customerName: detail.customerName,
      customerEmail: detail.customerEmail,
      customerPhone: detail.customerPhone,
      externalClientRef: detail.externalClientRef,
      // D13.b's best-effort client match is Phase F/panel scope, not this sync.
      clientId: existing?.clientId ?? null,
      openedAt: detail.openedAt,
      lastMessageAt: detail.lastMessageAt,
      contentHash,
      syncedAt: nowIso,
    });

    let messageRecords: SuricataMessageRecord[] = [];
    if (detail.messages.length > 0) {
      messageRecords = await this.messages.upsertManyByExternalId(
        ticket.id,
        detail.messages.map((m) => ({
          externalId: m.externalId,
          author: m.author,
          authorKind: m.authorKind,
          body: m.body,
          sentAt: m.sentAt,
        })),
      );
    }

    let attachmentsStored = 0;
    for (let i = 0; i < detail.messages.length; i += 1) {
      const scrapedMessage = detail.messages[i];
      const messageRecord = messageRecords[i] as SuricataMessageRecord | undefined;
      for (const ref of scrapedMessage.attachments) {
        const stored = await this.syncAttachment(ticket.id, messageRecord?.id ?? null, ref);
        if (stored) attachmentsStored += 1;
      }
    }

    return { ticketUpserted: true, messagesUpserted: messageRecords.length, attachmentsStored };
  }

  /**
   * MIRROR-7/D7 — download an attachment independent of any Suricata
   * session/cookie and persist it under `suricata/<sha256>` (dedup by
   * content). Isolated per attachment: one failure never aborts the ticket
   * nor the run.
   */
  private async syncAttachment(
    ticketId: string,
    messageId: string | null,
    ref: SuricataScrapedAttachmentRef,
  ): Promise<boolean> {
    const row = await this.attachments.upsertByExternalRef({
      ticketId,
      messageId,
      externalRef: ref.externalRef,
      fileName: ref.fileName,
      mimeType: ref.mimeType,
      sizeBytes: ref.sizeBytes ?? null,
    });

    if (row.status === 'stored') return false; // already migrated -- nothing to do
    if (row.attempts >= MAX_ATTACHMENT_ATTEMPTS) return false; // abandoned, D6.b -- no infinite retry

    try {
      const fetched = await this.scraper.fetchAttachment(ref.externalRef);

      if (fetched.buffer.length > this.cfg.maxAttachmentBytes) {
        await this.attachments.markFailed(row.id, { error: 'too_large' });
        return false;
      }

      const sha256 = createHash('sha256').update(fetched.buffer).digest('hex');
      const storageKey = `suricata/${sha256}`;
      await this.fileStorage.save({ key: storageKey, buffer: fetched.buffer, mimeType: fetched.mimeType });
      await this.attachments.markStored(row.id, { sha256, storageKey, sizeBytes: fetched.buffer.length });
      return true;
    } catch (err) {
      await this.attachments.markFailed(row.id, { error: (err as Error).message });
      return false;
    }
  }
}
