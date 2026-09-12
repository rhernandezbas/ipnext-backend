/**
 * SuricataSession (suricata-tickets-mirror, Phase B, D4) — mutex that serializes
 * access to the SINGLE authenticated Playwright session shared by the sync job
 * (Phase C, priority 'low') and the reply action (Phase E, priority 'high').
 *
 * D3.c — the DOMAIN never knows about this lock: `withSession` lives entirely
 * in infrastructure, and the ports the use cases depend on (`SuricataScraperPort`,
 * `SuricataReplyPort`) carry neither `lock` nor `priority` in their signature.
 * The concrete Playwright adapters (Phase C `PlaywrightSuricataScraper`, Phase E
 * `PlaywrightSuricataReply`) are the ones that call `withSession` internally —
 * that wiring does not exist yet, so this phase depends on NOTHING from
 * `playwright-core` (added in Phase J): `TSession` is a narrow structural
 * interface (`SuricataAuthSession`) capturing exactly what the mutex itself
 * needs to reason about authentication, not the real `BrowserContext`.
 *
 * D4 — TWO locks, same reasoning as `CampaignRunner` (FIX-3 precedent):
 *   1. An in-process priority queue (`high` jumps ahead of queued `low`, FIFO
 *      within a level) — the lock that REALLY serializes a single container.
 *      Check+enqueue is SYNCHRONOUS before the first `await`, molde
 *      `CampaignRunner.heldInProcess`.
 *   2. `PgAdvisoryLock` key `'suricata-session'` on top, for CROSS-REPLICA
 *      exclusion. It is re-entrant within one pg session (same gotcha as
 *      `PgAdvisoryLock`'s own doc comment / FIX-3), so it alone cannot stop two
 *      concurrent callers on the SAME container — that is exactly what #1 is
 *      for. If another REPLICA holds it, `tryAcquire` returns false and this
 *      call fails the same way a queue timeout does: `SuricataSessionBusyError`.
 *
 * `ensureAuthenticated` runs INSIDE the mutex, before `fn`: navigates a cheap
 * authenticated route and classifies by DOM marker; on failure it logs in
 * ONCE and re-checks ONCE — a second failure raises `SuricataAuthError` and
 * `fn` is never invoked. No blind retry loop (D4: hammering logins against a
 * third-party account is worse than a skipped sync tick).
 */
import type { DistributedLock } from '@domain/ports/DistributedLock';
import { SuricataSessionBusyError, SuricataAuthError } from '@domain/errors/suricata';

export type SuricataSessionPriority = 'high' | 'low';

export interface SuricataSessionOptions {
  priority: SuricataSessionPriority;
  timeoutMs: number;
}

/**
 * Narrow structural session contract `SuricataSession` needs. Phase C/E's real
 * adapters implement this ON TOP of a `BrowserContext` (plus whatever else they
 * need for scraping/replying) — this interface only covers what the mutex
 * itself has to do: classify auth state by DOM marker and (re)log in.
 */
export interface SuricataAuthSession {
  /** Navigate to a cheap authenticated-only route and classify by DOM marker. */
  isAuthenticated(): Promise<boolean>;
  /** Perform the login flow (fills credentials, submits, waits for the redirect). */
  login(): Promise<void>;
}

/** Key shared with `PgAdvisoryLock` for the cross-replica exclusion layer (D4). */
export const SURICATA_SESSION_LOCK_KEY = 'suricata-session';

/**
 * D4 — DOM-marker classification with a single re-login and a single retry.
 * Exported standalone (not a private method) so it is unit-testable without
 * going through the mutex, and reusable if a caller ever needs to force a
 * fresh classification outside `withSession`.
 */
export async function ensureAuthenticated(session: SuricataAuthSession): Promise<void> {
  if (await session.isAuthenticated()) return;

  await session.login();

  if (await session.isAuthenticated()) return;

  throw new SuricataAuthError();
}

interface QueueEntry {
  priority: SuricataSessionPriority;
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SuricataSession<TSession extends SuricataAuthSession = SuricataAuthSession> {
  /** Molde `CampaignRunner.heldInProcess` — el candado que REALMENTE serializa. */
  private locked = false;
  private readonly queue: QueueEntry[] = [];

  constructor(
    private readonly session: TSession,
    private readonly lock: DistributedLock,
  ) {}

  async withSession<T>(opts: SuricataSessionOptions, fn: (session: TSession) => Promise<T>): Promise<T> {
    await this.acquireInProcess(opts.priority, opts.timeoutMs);
    try {
      const acquiredDistributed = await this.lock.tryAcquire(SURICATA_SESSION_LOCK_KEY);
      if (!acquiredDistributed) {
        // Otra RÉPLICA (sesión pg distinta) tiene la sesión — mismo tratamiento
        // que un timeout de cola: el pedido es válido, el recurso está ocupado.
        throw new SuricataSessionBusyError();
      }
      try {
        await ensureAuthenticated(this.session);
        return await fn(this.session);
      } finally {
        await this.lock.release(SURICATA_SESSION_LOCK_KEY);
      }
    } finally {
      this.releaseInProcess();
    }
  }

  /**
   * Check+enqueue SÍNCRONO (sin `await` en el medio) antes de resolver — molde
   * `CampaignRunner.heldInProcess`. Si el mutex está libre, se toma en el acto;
   * si no, la llamada se encola y su promesa se resuelve/rechaza más tarde
   * desde `releaseInProcess` o desde el timer de timeout.
   */
  private acquireInProcess(priority: SuricataSessionPriority, timeoutMs: number): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {
        priority,
        grant: () => {
          clearTimeout(entry.timer);
          this.locked = true;
          resolve();
        },
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new SuricataSessionBusyError());
        }, timeoutMs),
      };
      this.enqueue(entry);
    });
  }

  /** `high` salta delante de cualquier `low` YA encolado; FIFO dentro del mismo nivel. */
  private enqueue(entry: QueueEntry): void {
    if (entry.priority === 'high') {
      const firstLowIdx = this.queue.findIndex((e) => e.priority === 'low');
      if (firstLowIdx === -1) {
        this.queue.push(entry);
      } else {
        this.queue.splice(firstLowIdx, 0, entry);
      }
      return;
    }
    this.queue.push(entry);
  }

  private releaseInProcess(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) next.grant();
  }
}
