import { SyncSuricataTickets } from '@application/use-cases/suricata/SyncSuricataTickets';
import { FakeSuricataScraper } from '../helpers/FakeSuricataScraper';
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataMessageRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataMessageRepository';
import { InMemorySuricataAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAttachmentRepository';
import { InMemorySuricataAreaRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAreaRepository';
import { InMemorySuricataSyncRunRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataSyncRunRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import type { SuricataScraperPort, SuricataTicketDetail } from '@domain/ports/SuricataScraperPort';

/**
 * suricata-tickets-mirror (Phase C, tasks C.6/C.7/C.8, D6/D7/D12) — the sync use
 * case is tested exclusively against `FakeSuricataScraper` + InMemory ports
 * (repo convention: never mock Prisma in a use-case test). D6.b's "no abre el
 * detalle si el hash no cambió" optimization is asserted via `getTicketCalls`.
 */
const CFG = { backfillDays: 90, maxPagesPerRun: 20, maxAttachmentBytes: 10 * 1024 * 1024 };

function makeHarness() {
  const scraper = new FakeSuricataScraper();
  const tickets = new InMemorySuricataTicketRepository();
  const messages = new InMemorySuricataMessageRepository();
  const attachments = new InMemorySuricataAttachmentRepository();
  const areas = new InMemorySuricataAreaRepository();
  const syncRuns = new InMemorySuricataSyncRunRepository();
  const fileStorage = new InMemoryFileStorage();
  const useCase = new SyncSuricataTickets(scraper, tickets, messages, attachments, areas, syncRuns, fileStorage, CFG);
  return { scraper, tickets, messages, attachments, areas, syncRuns, fileStorage, useCase };
}

function ticketDetail(overrides: Partial<SuricataTicketDetail> & { externalId: string }): SuricataTicketDetail {
  return {
    subject: 'No tengo internet',
    status: 'abierto',
    priority: 'alta',
    areaExternalId: 'area-1',
    customerName: 'Juan Perez',
    customerEmail: 'juan@example.com',
    customerPhone: '+5491122334455',
    externalClientRef: 'CLI-1',
    openedAt: '2026-08-01T09:00:00.000Z',
    lastMessageAt: '2026-09-01T10:00:00.000Z',
    messages: [
      {
        externalId: `${overrides.externalId}-m1`,
        author: 'Juan Perez',
        authorKind: 'customer',
        body: 'No tengo internet',
        sentAt: '2026-09-01T09:55:00.000Z',
        attachments: [],
      },
    ],
    ...overrides,
  };
}

describe('SyncSuricataTickets', () => {
  describe('MIRROR-1 — first-run backfill', () => {
    it('paginates through the entire history and persists every ticket + its messages', async () => {
      const { scraper, tickets, messages, syncRuns, useCase } = makeHarness();
      scraper.areas = [{ externalId: 'area-1', name: 'Soporte' }];
      scraper.pagesByNumber.set(1, {
        tickets: [
          {
            externalId: 't-1',
            subject: 'No tengo internet',
            status: 'abierto',
            priority: 'alta',
            areaExternalId: 'area-1',
            lastMessageAt: '2026-09-01T10:00:00.000Z',
            messageCount: 1,
          },
        ],
        hasNextPage: true,
      });
      scraper.pagesByNumber.set(2, {
        tickets: [
          {
            externalId: 't-2',
            subject: 'Consulta de factura',
            status: 'cerrado',
            priority: 'baja',
            areaExternalId: 'area-1',
            lastMessageAt: '2026-08-30T10:00:00.000Z',
            messageCount: 1,
          },
        ],
        hasNextPage: false,
      });
      scraper.ticketDetailsByExternalId.set('t-1', ticketDetail({ externalId: 't-1' }));
      scraper.ticketDetailsByExternalId.set('t-2', ticketDetail({ externalId: 't-2', subject: 'Consulta de factura' }));

      const run = await useCase.execute();

      expect(run.outcome).toBe('ok');
      expect(scraper.listTicketPageCalls).toEqual([1, 2]);
      expect(await tickets.findByExternalId('t-1')).not.toBeNull();
      expect(await tickets.findByExternalId('t-2')).not.toBeNull();
      const t1 = await tickets.findByExternalId('t-1');
      expect((await messages.listByTicketId(t1!.id)).length).toBe(1);
      expect(run.ticketsSeen).toBe(2);
      expect(run.ticketsUpserted).toBe(2);
      const finished = await syncRuns.lastSuccessful();
      expect(finished?.id).toBe(run.id);
    });
  });

  describe('MIRROR-2 — incremental after backfill', () => {
    it('only fetches tickets newer than the last successful run watermark', async () => {
      const { scraper, syncRuns, useCase } = makeHarness();
      scraper.areas = [];
      // Simulate a prior successful run already recorded.
      const priorRun = await syncRuns.start();
      await syncRuns.finish(priorRun.id, {
        outcome: 'ok',
        ticketsSeen: 1,
        ticketsUpserted: 1,
        messagesUpserted: 1,
        attachmentsStored: 0,
      });

      scraper.pagesByNumber.set(1, {
        tickets: [
          {
            externalId: 't-new',
            subject: 'Ticket nuevo',
            status: 'abierto',
            priority: 'alta',
            areaExternalId: null,
            lastMessageAt: new Date(Date.now() + 60_000).toISOString(), // after the watermark
            messageCount: 1,
          },
          {
            externalId: 't-old',
            subject: 'Ticket viejo',
            status: 'cerrado',
            priority: 'baja',
            areaExternalId: null,
            lastMessageAt: new Date(Date.now() - 3600_000).toISOString(), // before the watermark
            messageCount: 1,
          },
        ],
        hasNextPage: false,
      });
      scraper.ticketDetailsByExternalId.set('t-new', ticketDetail({ externalId: 't-new', areaExternalId: null }));

      const run = await useCase.execute();

      expect(run.outcome).toBe('ok');
      expect(scraper.getTicketCalls).toEqual(['t-new']);
      expect(run.ticketsUpserted).toBe(1);
    });
  });

  describe('MIRROR-3 — idempotent persistence', () => {
    it('re-syncing the same unchanged ticket does not duplicate rows nor re-open the detail', async () => {
      const { scraper, tickets, messages, useCase } = makeHarness();
      scraper.areas = [];
      const summary = {
        externalId: 't-1',
        subject: 'No tengo internet',
        status: 'abierto',
        priority: 'alta',
        areaExternalId: null,
        lastMessageAt: '2026-09-01T10:00:00.000Z',
        messageCount: 3,
      };
      scraper.pagesByNumber.set(1, { tickets: [summary], hasNextPage: false });
      scraper.ticketDetailsByExternalId.set(
        't-1',
        ticketDetail({
          externalId: 't-1',
          areaExternalId: null,
          messages: [
            { externalId: 't-1-m1', author: 'Juan', authorKind: 'customer', body: 'a', sentAt: '2026-09-01T09:00:00.000Z', attachments: [] },
            { externalId: 't-1-m2', author: 'Soporte', authorKind: 'agent', body: 'b', sentAt: '2026-09-01T09:30:00.000Z', attachments: [] },
            { externalId: 't-1-m3', author: 'Juan', authorKind: 'customer', body: 'c', sentAt: '2026-09-01T10:00:00.000Z', attachments: [] },
          ],
        }),
      );

      const firstRun = await useCase.execute();
      const t1AfterFirst = await tickets.findByExternalId('t-1');
      const messagesAfterFirst = await messages.listByTicketId(t1AfterFirst!.id);

      // Second run: SAME summary (same content hash) -- must not re-open the detail.
      scraper.getTicketCalls.length = 0;
      const secondRun = await useCase.execute();
      const t1AfterSecond = await tickets.findByExternalId('t-1');
      const messagesAfterSecond = await messages.listByTicketId(t1AfterSecond!.id);

      expect(firstRun.ticketsUpserted).toBe(1);
      expect(secondRun.ticketsUpserted).toBe(0); // unchanged -- D6.b skip
      expect(scraper.getTicketCalls).toEqual([]); // detail never re-opened
      expect(messagesAfterSecond.length).toBe(messagesAfterFirst.length); // no duplicates
      expect(t1AfterSecond!.id).toBe(t1AfterFirst!.id);
    });
  });

  describe('MIRROR-4 — per-ticket retry, batch resilience', () => {
    it('one ticket that throws does not abort the run; the rest persist', async () => {
      const { scraper, tickets, useCase } = makeHarness();
      scraper.areas = [];
      scraper.pagesByNumber.set(1, {
        tickets: [
          { externalId: 't-ok-1', subject: 'ok 1', status: 'abierto', priority: null, areaExternalId: null, lastMessageAt: '2026-09-01T10:00:00.000Z', messageCount: 1 },
          { externalId: 't-fails', subject: 'falla', status: 'abierto', priority: null, areaExternalId: null, lastMessageAt: '2026-09-01T09:00:00.000Z', messageCount: 1 },
          { externalId: 't-ok-2', subject: 'ok 2', status: 'abierto', priority: null, areaExternalId: null, lastMessageAt: '2026-09-01T08:00:00.000Z', messageCount: 1 },
        ],
        hasNextPage: false,
      });
      scraper.ticketDetailsByExternalId.set('t-ok-1', ticketDetail({ externalId: 't-ok-1', areaExternalId: null }));
      scraper.ticketDetailsByExternalId.set('t-ok-2', ticketDetail({ externalId: 't-ok-2', areaExternalId: null }));
      scraper.failingTicketExternalIds.add('t-fails');

      const run = await useCase.execute();

      expect(await tickets.findByExternalId('t-ok-1')).not.toBeNull();
      expect(await tickets.findByExternalId('t-ok-2')).not.toBeNull();
      expect(await tickets.findByExternalId('t-fails')).toBeNull();
      expect(run.ticketsSeen).toBe(3);
      expect(run.ticketsUpserted).toBe(2);
      expect(run.outcome).toBe('degraded'); // MIRROR-5 -- visible, not silent
      expect(run.error).toContain('t-fails');
    });
  });

  describe('MIRROR-5 — visible failure, no data corruption', () => {
    it('a run that exhausts a ticket leaves previously persisted data intact and records the error', async () => {
      const { scraper, tickets, useCase } = makeHarness();
      scraper.areas = [];
      scraper.pagesByNumber.set(1, {
        tickets: [{ externalId: 't-1', subject: 'ok', status: 'abierto', priority: null, areaExternalId: null, lastMessageAt: '2026-09-01T10:00:00.000Z', messageCount: 1 }],
        hasNextPage: false,
      });
      scraper.ticketDetailsByExternalId.set('t-1', ticketDetail({ externalId: 't-1', areaExternalId: null }));
      const firstRun = await useCase.execute();
      expect(firstRun.outcome).toBe('ok');
      const persistedBefore = await tickets.findByExternalId('t-1');

      // Second run: an unrelated NEW ticket fails; t-1 was already synced and
      // unchanged. Listed activity-descending (D6.a) -- t-2 (newer than the
      // watermark) comes first, t-1 (older, already synced) after, so the
      // incremental cutoff naturally stops at t-1 without re-touching it.
      scraper.pagesByNumber.set(1, {
        tickets: [
          { externalId: 't-2', subject: 'falla', status: 'abierto', priority: null, areaExternalId: null, lastMessageAt: new Date(Date.now() + 60_000).toISOString(), messageCount: 1 },
          { externalId: 't-1', subject: 'ok', status: 'abierto', priority: null, areaExternalId: null, lastMessageAt: '2026-09-01T10:00:00.000Z', messageCount: 1 },
        ],
        hasNextPage: false,
      });
      scraper.failingTicketExternalIds.add('t-2');

      const secondRun = await useCase.execute();

      expect(secondRun.outcome).toBe('degraded');
      expect(secondRun.error).toBeTruthy();
      const persistedAfter = await tickets.findByExternalId('t-1');
      expect(persistedAfter).toEqual(persistedBefore); // untouched
      expect(await tickets.findByExternalId('t-2')).toBeNull();
    });
  });

  describe('MIRROR-4 — a degraded run must NOT advance the incremental watermark', () => {
    it('retries on the next run a ticket that failed (e.g. session busy) during a degraded run', async () => {
      const { scraper, tickets, syncRuns, useCase } = makeHarness();
      scraper.areas = [];
      const summary = {
        externalId: 't-busy',
        subject: 'sesion ocupada',
        status: 'abierto',
        priority: null,
        areaExternalId: null,
        // Older than "now", so on any run that treats the previous (degraded)
        // run's startedAt as the watermark this ticket falls below the cutoff
        // and is skipped forever.
        lastMessageAt: '2026-09-01T10:00:00.000Z',
        messageCount: 1,
      };
      scraper.pagesByNumber.set(1, { tickets: [summary], hasNextPage: false });
      scraper.ticketDetailsByExternalId.set('t-busy', ticketDetail({ externalId: 't-busy', areaExternalId: null }));
      scraper.failingTicketExternalIds.add('t-busy');

      const firstRun = await useCase.execute();
      expect(firstRun.outcome).toBe('degraded');
      expect(await tickets.findByExternalId('t-busy')).toBeNull();

      // A `degraded` run is NOT a reference point: `lastSuccessful()` must keep
      // reporting the last genuinely `ok` run (here: none at all), so the next
      // run sweeps the same window again and re-attempts the failed ticket.
      expect(await syncRuns.lastSuccessful()).toBeNull();

      // Second run: the transient condition cleared.
      scraper.failingTicketExternalIds.delete('t-busy');
      scraper.getTicketCalls.length = 0;

      const secondRun = await useCase.execute();

      expect(scraper.getTicketCalls).toEqual(['t-busy']); // actually retried
      expect(secondRun.outcome).toBe('ok');
      expect(secondRun.ticketsUpserted).toBe(1);
      expect(await tickets.findByExternalId('t-busy')).not.toBeNull();
      // Only now that a run closed `ok` does the watermark move.
      const successful = await syncRuns.lastSuccessful();
      expect(successful?.id).toBe(secondRun.id);
    });
  });

  describe('D6.d — a selector miss must NOT block the watermark', () => {
    it('a run with selector misses but ZERO failed tickets is still the reference for the next run', async () => {
      const { scraper, tickets, syncRuns, useCase } = makeHarness();
      scraper.areas = [];
      // An empty `subject` is D6.d invariant 2: the subject cell selector did
      // not match. The row is STILL mirrored by `syncOneTicket` -- no ticket is
      // lost, only a field is incomplete.
      scraper.pagesByNumber.set(1, {
        tickets: [
          {
            externalId: 't-miss',
            subject: '',
            status: 'abierto',
            priority: null,
            areaExternalId: null,
            lastMessageAt: '2026-09-01T10:00:00.000Z',
            messageCount: 1,
          },
        ],
        hasNextPage: false,
      });
      scraper.ticketDetailsByExternalId.set(
        't-miss',
        ticketDetail({ externalId: 't-miss', subject: '', areaExternalId: null }),
      );

      const firstRun = await useCase.execute();

      // Still VISIBLE as degraded -- a broken selector must never be silent.
      expect(firstRun.outcome).toBe('degraded');
      expect(firstRun.selectorMisses).toEqual(['t-miss']);
      // ...but nothing was left unmirrored, so there is no `error`.
      expect(firstRun.error).toBeNull();
      expect(await tickets.findByExternalId('t-miss')).not.toBeNull();

      // THE BUG: treating a selector miss as watermark-blocking pins the sync in
      // PERMANENT backfill — every later run re-sweeps the entire
      // `SURICATA_BACKFILL_DAYS` window, which can exceed `maxPagesPerRun` and
      // actually REDUCE coverage. Only a genuinely unmirrored ticket may block.
      const reference = await syncRuns.lastSuccessful();
      expect(reference?.id).toBe(firstRun.id);

      // Second run: a ticket whose activity predates the first run's start must
      // fall below the incremental cutoff and never be re-opened.
      scraper.getTicketCalls.length = 0;
      scraper.pagesByNumber.set(1, {
        tickets: [
          {
            externalId: 't-older',
            subject: 'anterior a la marca de agua',
            status: 'cerrado',
            priority: null,
            areaExternalId: null,
            lastMessageAt: '2026-09-02T10:00:00.000Z',
            messageCount: 1,
          },
        ],
        hasNextPage: false,
      });
      scraper.ticketDetailsByExternalId.set('t-older', ticketDetail({ externalId: 't-older', areaExternalId: null }));

      const secondRun = await useCase.execute();

      expect(scraper.getTicketCalls).toEqual([]); // incremental, not a re-backfill
      expect(secondRun.ticketsSeen).toBe(0);
    });

    it('a ticket that genuinely failed to mirror DOES still block the watermark, even alongside selector misses', async () => {
      const { scraper, syncRuns, useCase } = makeHarness();
      scraper.areas = [];
      scraper.pagesByNumber.set(1, {
        tickets: [
          {
            externalId: 't-miss',
            subject: '',
            status: 'abierto',
            priority: null,
            areaExternalId: null,
            lastMessageAt: '2026-09-01T10:00:00.000Z',
            messageCount: 1,
          },
          {
            externalId: 't-fails',
            subject: 'falla',
            status: 'abierto',
            priority: null,
            areaExternalId: null,
            lastMessageAt: '2026-09-01T09:00:00.000Z',
            messageCount: 1,
          },
        ],
        hasNextPage: false,
      });
      scraper.ticketDetailsByExternalId.set(
        't-miss',
        ticketDetail({ externalId: 't-miss', subject: '', areaExternalId: null }),
      );
      scraper.failingTicketExternalIds.add('t-fails');

      const run = await useCase.execute();

      expect(run.outcome).toBe('degraded');
      expect(run.selectorMisses).toEqual(['t-miss']);
      expect(run.error).toContain('t-fails');
      // The MIRROR-4 guarantee is untouched: a ticket that was never mirrored
      // keeps the cutoff where it is so the next run re-attempts it.
      expect(await syncRuns.lastSuccessful()).toBeNull();
    });
  });

  describe('MIRROR-6 — area catalog refresh without orphan loss', () => {
    it('a ticket keeps its area reference after that area disappears from the upstream catalog', async () => {
      const { scraper, tickets, areas, useCase } = makeHarness();
      scraper.areas = [{ externalId: 'area-1', name: 'Facturación' }];
      scraper.pagesByNumber.set(1, {
        tickets: [{ externalId: 't-1', subject: 'consulta', status: 'abierto', priority: null, areaExternalId: 'area-1', lastMessageAt: '2026-09-01T10:00:00.000Z', messageCount: 1 }],
        hasNextPage: false,
      });
      scraper.ticketDetailsByExternalId.set('t-1', ticketDetail({ externalId: 't-1', areaExternalId: 'area-1' }));
      const firstRun = await useCase.execute();
      expect(firstRun.outcome).toBe('ok');
      const areaBefore = await areas.findByExternalId('area-1');
      const ticketBefore = await tickets.findByExternalId('t-1');
      expect(ticketBefore!.areaId).toBe(areaBefore!.id);

      // Area "Facturación" no longer exists upstream, but the ticket itself is unchanged.
      scraper.areas = [];

      const secondRun = await useCase.execute();

      expect(secondRun.outcome).toBe('ok'); // does not error on the orphaned area
      const areaAfter = await areas.findByExternalId('area-1');
      expect(areaAfter!.active).toBe(false); // D6.c -- soft delete, never removed
      const ticketAfter = await tickets.findByExternalId('t-1');
      expect(ticketAfter!.areaId).toBe(areaBefore!.id); // ticket keeps the reference
    });
  });

  describe('D6.d — DOM roto invariant', () => {
    it('page 1 returning zero tickets fails the run loudly and writes nothing', async () => {
      const { scraper, tickets, useCase } = makeHarness();
      scraper.areas = [];
      scraper.pagesByNumber.set(1, { tickets: [], hasNextPage: false });

      const run = await useCase.execute();

      expect(run.outcome).toBe('failed');
      expect(run.ticketsUpserted).toBe(0);
      expect(run.error).toBeTruthy();
      expect(await tickets.findByExternalId('t-1')).toBeNull();
    });
  });

  describe('MIRROR-7 — attachments migrated to internal storage', () => {
    it('downloads and stores a new attachment by content sha256, independent of Suricata', async () => {
      const { scraper, attachments, fileStorage, useCase } = makeHarness();
      scraper.areas = [];
      scraper.pagesByNumber.set(1, {
        tickets: [{ externalId: 't-1', subject: 'con adjunto', status: 'abierto', priority: null, areaExternalId: null, lastMessageAt: '2026-09-01T10:00:00.000Z', messageCount: 1 }],
        hasNextPage: false,
      });
      scraper.ticketDetailsByExternalId.set(
        't-1',
        ticketDetail({
          externalId: 't-1',
          areaExternalId: null,
          messages: [
            {
              externalId: 't-1-m1',
              author: 'Juan',
              authorKind: 'customer',
              body: 'foto adjunta',
              sentAt: '2026-09-01T10:00:00.000Z',
              attachments: [{ externalRef: '/att/1.png', fileName: 'captura.png', mimeType: 'image/png', sizeBytes: 1024 }],
            },
          ],
        }),
      );
      scraper.attachmentsByRef.set('/att/1.png', {
        buffer: Buffer.from('fake-png-bytes'),
        mimeType: 'image/png',
        fileName: 'captura.png',
      });

      const run = await useCase.execute();

      expect(run.attachmentsStored).toBe(1);
      const rows = await attachments.listRetriable({ maxAttempts: 5 });
      expect(rows).toEqual([]); // stored rows are never "retriable"
      const sha256 = require('crypto').createHash('sha256').update('fake-png-bytes').digest('hex');
      const stored = await fileStorage.get(`suricata/${sha256}`);
      expect(stored).not.toBeNull();
      expect(stored!.mimeType).toBe('image/png');
    });

    it('a file over SURICATA_MAX_ATTACHMENT_BYTES is marked failed with lastError=too_large, no bytes stored', async () => {
      const scraper = new FakeSuricataScraper();
      const tickets = new InMemorySuricataTicketRepository();
      const messages = new InMemorySuricataMessageRepository();
      const attachments = new InMemorySuricataAttachmentRepository();
      const areas = new InMemorySuricataAreaRepository();
      const syncRuns = new InMemorySuricataSyncRunRepository();
      const fileStorage = new InMemoryFileStorage();
      const tinyLimitUseCase = new SyncSuricataTickets(scraper, tickets, messages, attachments, areas, syncRuns, fileStorage, {
        ...CFG,
        maxAttachmentBytes: 100, // smaller than the 200-byte fixture below
      });

      scraper.areas = [];
      scraper.pagesByNumber.set(1, {
        tickets: [{ externalId: 't-1', subject: 'adjunto grande', status: 'abierto', priority: null, areaExternalId: null, lastMessageAt: '2026-09-01T10:00:00.000Z', messageCount: 1 }],
        hasNextPage: false,
      });
      scraper.ticketDetailsByExternalId.set(
        't-1',
        ticketDetail({
          externalId: 't-1',
          areaExternalId: null,
          messages: [
            {
              externalId: 't-1-m1',
              author: 'Juan',
              authorKind: 'customer',
              body: 'archivo pesado',
              sentAt: '2026-09-01T10:00:00.000Z',
              attachments: [{ externalRef: '/att/big.bin', fileName: 'big.bin', mimeType: 'application/octet-stream', sizeBytes: 999 }],
            },
          ],
        }),
      );
      scraper.attachmentsByRef.set('/att/big.bin', {
        buffer: Buffer.alloc(200),
        mimeType: 'application/octet-stream',
        fileName: 'big.bin',
      });

      const run = await tinyLimitUseCase.execute();

      expect(run.attachmentsStored).toBe(0);
      const retriable = await attachments.listRetriable({ maxAttempts: 5 });
      expect(retriable).toHaveLength(1);
      expect(retriable[0].status).toBe('failed');
      expect(retriable[0].lastError).toBe('too_large');
      expect(retriable[0].storageKey).toBeNull();
    });
  });

  describe('SSRF guard — an attachment pointing outside baseUrl', () => {
    it('leaves the row failed with lastError=invalid_origin and stores no bytes', async () => {
      const { scraper, attachments, fileStorage, useCase } = makeHarness();
      scraper.areas = [];
      scraper.pagesByNumber.set(1, {
        tickets: [{ externalId: 't-1', subject: 'adjunto hostil', status: 'abierto', priority: null, areaExternalId: null, lastMessageAt: '2026-09-01T10:00:00.000Z', messageCount: 1 }],
        hasNextPage: false,
      });
      const hostileRef = 'http://169.254.169.254/latest/meta-data/';
      scraper.ticketDetailsByExternalId.set(
        't-1',
        ticketDetail({
          externalId: 't-1',
          areaExternalId: null,
          messages: [
            {
              externalId: 't-1-m1',
              author: 'Juan',
              authorKind: 'customer',
              body: 'mira esto',
              sentAt: '2026-09-01T10:00:00.000Z',
              attachments: [{ externalRef: hostileRef, fileName: 'x.png', mimeType: 'image/png', sizeBytes: 10 }],
            },
          ],
        }),
      );
      scraper.invalidOriginAttachmentRefs.add(hostileRef);

      const run = await useCase.execute();

      expect(run.attachmentsStored).toBe(0);
      const retriable = await attachments.listRetriable({ maxAttempts: 5 });
      expect(retriable).toHaveLength(1);
      expect(retriable[0].status).toBe('failed');
      expect(retriable[0].lastError).toBe('invalid_origin');
      expect(retriable[0].storageKey).toBeNull();
      expect(fileStorage.store.size).toBe(0);
    });
  });

  describe('MIRROR-8 — read-only guard', () => {
    it('a sync run never invokes anything beyond the four read-only SuricataScraperPort methods', async () => {
      const { tickets, messages, attachments, areas, syncRuns, fileStorage } = makeHarness();
      const fake = new FakeSuricataScraper();
      fake.areas = [];
      fake.pagesByNumber.set(1, {
        tickets: [{ externalId: 't-1', subject: 'x', status: 'abierto', priority: null, areaExternalId: null, lastMessageAt: '2026-09-01T10:00:00.000Z', messageCount: 1 }],
        hasNextPage: false,
      });
      fake.ticketDetailsByExternalId.set('t-1', ticketDetail({ externalId: 't-1', areaExternalId: null }));

      const allowed = new Set(['listAreas', 'listTicketPage', 'getTicket', 'fetchAttachment']);
      const guarded = new Proxy(fake, {
        get(target, prop, _receiver) {
          if (typeof prop === 'string' && !allowed.has(prop) && !(prop in Promise.prototype)) {
            throw new Error(`MIRROR-8 violation: touched non-read member '${prop}' on SuricataScraperPort`);
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as unknown as SuricataScraperPort;

      const guardedUseCase = new SyncSuricataTickets(guarded, tickets, messages, attachments, areas, syncRuns, fileStorage, CFG);
      const run = await guardedUseCase.execute();
      expect(run.outcome).toBe('ok');
    });
  });
});
