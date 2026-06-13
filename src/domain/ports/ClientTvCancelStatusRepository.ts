import type { CancelTvResult } from '@application/dto/gigared.dto';

/**
 * ClientTvCancelStatusRepository — async TV-cancel status tracker (#10/#11).
 *
 * Persists the in-progress / terminal state of a TV cancellation job for a client.
 * Stored in the mirror DB (Client table) as three nullable columns:
 *   tvCancelStatus    — 'pending' | 'running' | 'done' | 'failed'
 *   tvCancelResult    — CancelTvResult JSON on done; {error:string} on failed
 *   tvCancelStartedAt — when the runner set status to 'running'
 *
 * GR sync NEVER writes these columns — they are mirror-only async-job state.
 *
 * All methods are idempotent in the sense that writing the same status twice
 * is always safe (last-write wins).
 */

export type TvCancelStatusValue = 'pending' | 'running' | 'done' | 'failed';

export interface TvCancelStatusRow {
  status: TvCancelStatusValue;
  result?: CancelTvResult | { error: string };
  startedAt?: Date;
}

export interface ClientTvCancelStatusRepository {
  /**
   * Reads the current cancel status for a client.
   * Returns null if no cancel job has ever been queued for this client.
   */
  getStatus(clientId: string): Promise<TvCancelStatusRow | null>;

  /**
   * Writes the cancel status (and optional result / startedAt) for a client.
   * Creates or overwrites the previous value atomically.
   */
  setStatus(clientId: string, row: TvCancelStatusRow): Promise<void>;
}
