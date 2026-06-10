import type { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';

/** Parsed counts packed in lastResult — emitted to FE in the status response. */
interface SyncCounts {
  sites: number | null;
  devices: number | null;
  missing: number | null;
  durationMs: number | null;
}

/**
 * Parses sites/devices/missing/durationMs out of lastResult.
 *
 * lastResult format:
 *   ok: {"sites":73,"devices":4009,"missing":2,"durationMs":1200}   → counts
 *   ok: {"sites":73,"devices":4009,"missing":0}                      → durationMs null (old rows)
 *   error: <msg>                                                      → all null
 *   null / unknown format                                             → all null
 */
function parseCounts(lastResult: string | null): SyncCounts {
  if (!lastResult || !lastResult.startsWith('ok:')) {
    return { sites: null, devices: null, missing: null, durationMs: null };
  }
  try {
    const json = lastResult.slice('ok:'.length).trim();
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return {
      sites:     typeof parsed['sites']     === 'number' ? parsed['sites']     : null,
      devices:   typeof parsed['devices']   === 'number' ? parsed['devices']   : null,
      missing:   typeof parsed['missing']   === 'number' ? parsed['missing']   : null,
      durationMs: typeof parsed['durationMs'] === 'number' ? parsed['durationMs'] : null,
    };
  } catch {
    return { sites: null, devices: null, missing: null, durationMs: null };
  }
}

/**
 * Parses the error message from lastResult when it starts with 'error: '.
 * Returns null when not an error result.
 */
function parseLastError(lastResult: string | null): string | null {
  if (!lastResult || !lastResult.startsWith('error:')) return null;
  return lastResult.slice('error:'.length).trim();
}

export interface UispSyncStatusResult {
  lastRunAt: Date | null;
  lastResult: string | null;
  itemsSynced: number;
  /** configured = UISP_BASE_URL + UISP_TOKEN both present at boot time */
  configured: boolean;
  /** enabled = feature flag 'uisp-sync' is ON */
  enabled: boolean;
  // FIX-2b: counts parsed from ok: {...} JSON in lastResult
  /** Number of sites in last successful sync (null when never run or last run failed). */
  sites: number | null;
  /** Number of devices in last successful sync (null when never run or last run failed). */
  devices: number | null;
  /** Number of items marked missing in last successful sync (null when never run or failed). */
  missing: number | null;
  /** Duration of last successful sync in ms (null when never run, failed, or old row). */
  durationMs: number | null;
  /** Error message from last failed sync, null when last run succeeded or never run. */
  lastError: string | null;
}

/**
 * GetUispSyncStatus — reads the last run state from SyncState + flag status.
 * configured is injected at construction time (derived from config.uisp at wiring time).
 *
 * FIX-2b: emits counts (sites/devices/missing/durationMs) parsed from the JSON packed
 * in lastResult by SyncUispMirror, and lastError from error: <msg> entries.
 */
export class GetUispSyncStatus {
  constructor(
    private readonly syncStateRepo: SyncStateRepository,
    private readonly flagRepo: FeatureFlagRepository,
    /** True when UISP_BASE_URL and UISP_TOKEN are both non-empty at boot. */
    private readonly configured: boolean,
  ) {}

  async execute(): Promise<UispSyncStatusResult> {
    const [state, flag] = await Promise.all([
      this.syncStateRepo.get('uisp-mirror'),
      this.flagRepo.get('uisp-sync'),
    ]);

    const lastResult = state?.lastResult ?? null;
    const counts = parseCounts(lastResult);
    const lastError = parseLastError(lastResult);

    return {
      lastRunAt: state?.lastRunAt ?? null,
      lastResult,
      itemsSynced: state?.itemsSynced ?? 0,
      configured: this.configured,
      enabled: flag?.enabled ?? false,
      sites: counts.sites,
      devices: counts.devices,
      missing: counts.missing,
      durationMs: counts.durationMs,
      lastError,
    };
  }
}
