/**
 * bootstrapSuricataSync (suricata-tickets-mirror, Phase C task C.10 + Phase J
 * task J.1, D5/D11/D14) — composition root for the Suricata Cx ticket mirror
 * sync scheduler.
 *
 * Returns null when `SURICATA_BASE_URL` or `SURICATA_BROWSER_WS` is unset
 * (D5/D11 opt-in, molde `bootstrapChatMediaDownload`): the scheduler NEVER
 * starts and no network call to Suricata is ever attempted. The real ON/OFF
 * switch in prod is the `suricata-sync-enabled` feature flag (dark by
 * default, D14 "Deploy DARK") — this bootstrap is a SEPARATE, stricter gate
 * that also requires the actual sidecar/credentials to exist.
 *
 * Phase J — real wiring: when both envs ARE set, this constructs the real
 * object graph (`PlaywrightBrowserSession` → `SuricataSession` →
 * `PlaywrightSuricataScraper` → `SyncSuricataTickets` → `SuricataSyncScheduler`).
 * Construction itself does ZERO network I/O: `PlaywrightBrowserSession`
 * connects to the sidecar LAZILY, on the first call a sync tick actually
 * makes — so an unreachable/not-yet-deployed sidecar never crashes the boot,
 * it only fails that tick's `SuricataSyncRun` (`outcome='failed'`), which
 * `SuricataSyncScheduler.runOnce` already catches and logs (molde
 * `ChatMediaDownloadScheduler`).
 */
import { config } from '../config';
import { PlaywrightBrowserSession } from '../adapters/suricata/PlaywrightBrowserSession';
import { SuricataSession } from '../adapters/suricata/SuricataSession';
import { PlaywrightSuricataScraper } from '../adapters/suricata/PlaywrightSuricataScraper';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { PrismaSuricataTicketRepository } from '../adapters/prisma/PrismaSuricataTicketRepository';
import { PrismaSuricataMessageRepository } from '../adapters/prisma/PrismaSuricataMessageRepository';
import { PrismaSuricataAttachmentRepository } from '../adapters/prisma/PrismaSuricataAttachmentRepository';
import { PrismaSuricataAreaRepository } from '../adapters/prisma/PrismaSuricataAreaRepository';
import { PrismaSuricataSyncRunRepository } from '../adapters/prisma/PrismaSuricataSyncRunRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { MinioFileStorage } from '../adapters/minio/MinioFileStorage';
import { SyncSuricataTickets } from '@application/use-cases/suricata/SyncSuricataTickets';
import { SuricataSyncScheduler } from './SuricataSyncScheduler';

/** D4 — the sync lane always requests the shared session at 'low' priority, 5s budget (hardcoded, not env-configurable — only the reply lane's timeout is, per D11). */
const SURICATA_SYNC_SESSION_TIMEOUT_MS = 5_000;

export async function bootstrapSuricataSync(
  intervalMs = config.suricata.syncIntervalMs,
): Promise<SuricataSyncScheduler | null> {
  const { baseUrl, browserWs, user, password, backfillDays, maxPagesPerRun, maxAttachmentBytes } = config.suricata;

  if (!baseUrl || !browserWs) {
    console.warn('[suricata-sync] SURICATA_BASE_URL/SURICATA_BROWSER_WS missing -- scheduler disabled');
    return null;
  }

  const browserSession = new PlaywrightBrowserSession({ browserWs, baseUrl, username: user, password });
  const session = new SuricataSession(browserSession, new PgAdvisoryLock());
  const scraper = new PlaywrightSuricataScraper(session, { baseUrl, sessionTimeoutMs: SURICATA_SYNC_SESSION_TIMEOUT_MS });

  const ticketRepo = new PrismaSuricataTicketRepository();
  const messageRepo = new PrismaSuricataMessageRepository();
  const attachmentRepo = new PrismaSuricataAttachmentRepository();
  const areaRepo = new PrismaSuricataAreaRepository();
  const syncRunRepo = new PrismaSuricataSyncRunRepository();
  // D7.a — same MinIO bucket task-photos/messaging use, prefix 'suricata/'
  // isolates it logically; `SyncSuricataTickets` builds the `suricata/<sha256>`
  // key itself, this is just the (lazy, opt-in) storage adapter instance.
  const fileStorage = new MinioFileStorage({
    endPoint: config.minio.endPoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
    bucket: config.minio.bucket,
  });

  const syncUseCase = new SyncSuricataTickets(
    scraper,
    ticketRepo,
    messageRepo,
    attachmentRepo,
    areaRepo,
    syncRunRepo,
    fileStorage,
    { backfillDays, maxPagesPerRun, maxAttachmentBytes },
  );

  const flags = new PrismaFeatureFlagRepository();
  const lock = new PgAdvisoryLock();

  return new SuricataSyncScheduler(syncUseCase, { intervalMs }, lock, flags);
}
