/**
 * ChatMediaDownloadScheduler (messaging-inbox-v2-media, F1.5 fase A, Tanda 1 · MEDIA-3)
 * — clon EXACTO de `RadiusAuthIngestScheduler`:
 *   - setInterval + timer.unref()
 *   - inFlight flag (intra-proceso, síncrono antes del primer await)
 *   - DistributedLock cross-replica con key 'chat-media-download'
 *   - Feature flag gate 'chat-media-download' (dark by default)
 *   - Una fila que lanza NO detiene el resto del barrido ni tumba el scheduler
 *   - runOnce() exportado para tests
 */
import type { ChatMessageAttachmentRepository } from '@domain/ports/ChatMessageAttachmentRepository';
import type { DownloadChatMessageAttachment } from '@application/use-cases/messaging/DownloadChatMessageAttachment';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';

const LOCK_KEY = 'chat-media-download';
const FLAG_KEY = 'chat-media-download';
/** MEDIA-3 — abandon a row after this many failed attempts (no infinite retry loop). */
const MAX_ATTEMPTS = 5;

export interface ChatMediaDownloadSchedulerOptions {
  intervalMs: number;
  /** Suprimir console en tests. */
  silent?: boolean;
}

export interface ChatMediaDownloadRunSummary {
  skipped?: boolean;
  error?: string;
  processed?: number;
  failed?: number;
}

export class ChatMediaDownloadScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly attachments: ChatMessageAttachmentRepository,
    private readonly downloadUseCase: DownloadChatMessageAttachment,
    private readonly opts: ChatMediaDownloadSchedulerOptions,
    private readonly lock: DistributedLock,
    private readonly flags: FeatureFlagRepository,
  ) {}

  start(): void {
    this.log(`[chat-media-download] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    // No mantener el event loop vivo solo por el timer.
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[chat-media-download] stopped');
  }

  async runOnce(): Promise<ChatMediaDownloadRunSummary> {
    // inFlight SÍNCRONO antes del PRIMER await: mismo guard intra-proceso que
    // RadiusAuthIngestScheduler, evita que dos ticks simultáneos se pisen.
    if (this.inFlight) {
      this.log('[chat-media-download] skipped -- previous run still in flight');
      return { skipped: true };
    }
    this.inFlight = true;

    // OUTER try: garantiza inFlight=false SIEMPRE, incluso si flags.get o tryAcquire lanzan.
    let acquired = false;
    try {
      // Gate de feature flag (dark by default), tras el inFlight check.
      const flag = await this.flags.get(FLAG_KEY);
      if (!flag?.enabled) {
        this.log('[chat-media-download] skipped -- flag disabled');
        return { skipped: true };
      }

      // Distributed lock cross-replica.
      acquired = await this.lock.tryAcquire(LOCK_KEY);
      if (!acquired) {
        this.log('[chat-media-download] skipped -- lock held by another instance');
        return { skipped: true };
      }

      try {
        const rows = await this.attachments.listRetriable({ maxAttempts: MAX_ATTEMPTS });
        let processed = 0;
        let failed = 0;
        // MEDIA-3/scenario 15 — a single row throwing an uncontrolled exception must
        // NOT stop the sweep nor take down the scheduler; each row is isolated.
        for (const row of rows) {
          try {
            await this.downloadUseCase.execute(row.id);
            processed += 1;
          } catch (err) {
            failed += 1;
            this.log(`[chat-media-download] row ${row.id} threw during sweep: ${(err as Error).message}`);
          }
        }
        this.log(`[chat-media-download] done: processed=${processed} failed=${failed}`);
        return { processed, failed };
      } catch (err) {
        const message = (err as Error).message;
        this.log(`[chat-media-download] ERROR: ${message}`);
        return { error: message };
      } finally {
        if (acquired) await this.lock.release(LOCK_KEY);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}
