import type { UispSyncScheduler, TriggerResult } from '@infrastructure/scheduling/UispSyncScheduler';

export interface TriggerUispSyncResult {
  queued: boolean;
  reason?: 'already-running' | 'flag-disabled';
}

/**
 * TriggerUispSync — calls scheduler.triggerNow() and maps the result to HTTP response shape.
 * SCEN-SYNC-05: { queued: true } → 202
 * SCEN-SYNC-06: { queued: false, reason } → 409
 */
export class TriggerUispSync {
  constructor(private readonly scheduler: UispSyncScheduler) {}

  async execute(): Promise<TriggerUispSyncResult> {
    const result: TriggerResult = await this.scheduler.triggerNow();
    if (result.queued) {
      return { queued: true };
    }
    return { queued: false, reason: result.reason };
  }
}
