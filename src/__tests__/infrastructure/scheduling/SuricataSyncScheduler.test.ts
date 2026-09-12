import { SuricataSyncScheduler } from '@infrastructure/scheduling/SuricataSyncScheduler';
import { SyncSuricataTickets } from '@application/use-cases/suricata/SyncSuricataTickets';
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataMessageRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataMessageRepository';
import { InMemorySuricataAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAttachmentRepository';
import { InMemorySuricataAreaRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAreaRepository';
import { InMemorySuricataSyncRunRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataSyncRunRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { FakeSuricataScraper } from '../../helpers/FakeSuricataScraper';

/**
 * suricata-tickets-mirror (Phase C, task C.9, D0/D14) — molde EXACTO
 * `ChatMediaDownloadScheduler`: setInterval+unref, inFlight sync guard,
 * `DistributedLock` cross-replica, feature flag gate, dark by default.
 */
const FLAG_KEY = 'suricata-sync-enabled';

function makeHarness(flagEnabled: boolean) {
  const scraper = new FakeSuricataScraper();
  const useCase = new SyncSuricataTickets(
    scraper,
    new InMemorySuricataTicketRepository(),
    new InMemorySuricataMessageRepository(),
    new InMemorySuricataAttachmentRepository(),
    new InMemorySuricataAreaRepository(),
    new InMemorySuricataSyncRunRepository(),
    new InMemoryFileStorage(),
    { backfillDays: 90, maxPagesPerRun: 20, maxAttachmentBytes: 10 * 1024 * 1024 },
  );
  const lock = new InMemoryDistributedLock();
  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG_KEY, flagEnabled);
  const scheduler = new SuricataSyncScheduler(useCase, { intervalMs: 1000, silent: true }, lock, flags);
  return { scraper, useCase, lock, flags, scheduler };
}

describe('SuricataSyncScheduler', () => {
  it('dark by default — flag OFF -> skips without running the use case', async () => {
    const { scheduler, useCase } = makeHarness(false);
    const spy = jest.spyOn(useCase, 'execute');

    const summary = await scheduler.runOnce();

    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('flag ON -> runs the sync use case and returns its run summary', async () => {
    const { scraper, scheduler } = makeHarness(true);
    scraper.pagesByNumber.set(1, { tickets: [], hasNextPage: false });

    const summary = await scheduler.runOnce();

    expect(summary.skipped).toBeUndefined();
    expect(summary.outcome).toBe('failed'); // D6.d -- empty page 1 fails loudly, exercised here just to prove wiring
  });

  it('cross-replica lock held elsewhere -> skips without running', async () => {
    const { scheduler, useCase, lock } = makeHarness(true);
    lock.forceAcquireFails = true;
    const spy = jest.spyOn(useCase, 'execute');

    const summary = await scheduler.runOnce();

    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('releases the lock even when the use case throws', async () => {
    const { scheduler, useCase, lock } = makeHarness(true);
    jest.spyOn(useCase, 'execute').mockRejectedValueOnce(new Error('boom'));

    const summary = await scheduler.runOnce();

    expect(summary.error).toContain('boom');
    expect(lock.heldKeys.size).toBe(0);
  });

  it('a second concurrent tick is skipped while one is already in flight (inFlight guard)', async () => {
    const { scheduler, useCase } = makeHarness(true);
    let resolveExecute!: () => void;
    jest.spyOn(useCase, 'execute').mockReturnValueOnce(
      new Promise((resolve) => {
        resolveExecute = () =>
          resolve({
            id: 'run-1',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            outcome: 'ok',
            ticketsSeen: 0,
            ticketsUpserted: 0,
            messagesUpserted: 0,
            attachmentsStored: 0,
            error: null,
            selectorMisses: null,
          });
      }),
    );

    const first = scheduler.runOnce();
    const second = await scheduler.runOnce();
    expect(second.skipped).toBe(true);

    resolveExecute();
    await first;
  });
});
