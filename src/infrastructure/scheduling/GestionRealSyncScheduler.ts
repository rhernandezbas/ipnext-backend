import { SyncGestionRealClients, SyncRunResult } from '@application/use-cases/SyncGestionRealClients';
import { SyncGestionRealContracts, ContractSyncResult } from '@application/use-cases/SyncGestionRealContracts';

export interface SchedulerOptions {
  intervalMs: number;
  /** Suppress console logging (tests). */
  silent?: boolean;
}

export interface RunSummary {
  skipped?: boolean;
  error?: string;
  clients?: SyncRunResult;
  contracts?: ContractSyncResult;
}

/**
 * In-process scheduler for the Gestión Real mirror. Runs client sync then
 * contract sync on a fixed interval. A single in-flight lock prevents
 * overlapping runs when a sync outlasts the interval, and errors are swallowed
 * so one bad cycle never kills the timer.
 *
 * Lifecycle is owned by main.ts and only started when GR_SYNC_ENABLED=true —
 * when off, nothing here ever runs.
 */
export class GestionRealSyncScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly syncClients: SyncGestionRealClients,
    private readonly syncContracts: SyncGestionRealContracts,
    private readonly opts: SchedulerOptions,
  ) {}

  start(): void {
    this.log(`[gr-sync] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    // Don't keep the event loop alive just for the sync timer.
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[gr-sync] stopped');
  }

  async runOnce(): Promise<RunSummary> {
    if (this.inFlight) {
      this.log('[gr-sync] skipped — previous run still in flight');
      return { skipped: true };
    }
    this.inFlight = true;
    try {
      const clients = await this.syncClients.execute();
      const contracts = await this.syncContracts.execute(clients.touchedClientIds);
      this.log(
        `[gr-sync] ${clients.mode}: clients +${clients.created}/~${clients.updated}, ` +
        `contracts +${contracts.created}/~${contracts.updated}`,
      );
      return { clients, contracts };
    } catch (err) {
      const message = (err as Error).message;
      this.log(`[gr-sync] ERROR: ${message}`);
      return { error: message };
    } finally {
      this.inFlight = false;
    }
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}
