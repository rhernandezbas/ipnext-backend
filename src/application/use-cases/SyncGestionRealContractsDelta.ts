import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { ClientMirrorRepository } from '@domain/ports/ClientMirrorRepository';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';

const SYNC_ENTITY = 'gr-contracts-delta';
const SYNC_FLAG_KEY = 'gestion-real-sync';
const DEFAULT_PAGE_SIZE = 100;

export interface ContractDeltaResult {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  cursor: string;
  /** True when the run was a no-op because the feature flag was off/missing. */
  skippedFlag?: true;
}

/**
 * Global contract delta sync: pulls contracts modified OR created since the last
 * cursor date via TWO GR feeds (fecha_tipo=m AND fecha_tipo=c), deduped per run.
 *
 * WHY two scans: GR does NOT set `modificado` on newly created contracts (verified
 * live: IDs 12116, 12144, 12148 — 12 days of data, only visible via fecha_tipo=c).
 * fecha_tipo=m EXCLUDES rows with empty modificado, so a c-scan is mandatory to
 * close that gap. Same pattern as SyncGestionRealClients (clients.ts lines ~106-138).
 *
 * - First run (no cursor) → bootstraps to today (historical backfill is
 *   `gr-contracts-backfill`'s responsibility, not ours).
 * - Subsequent runs → overlap of ≥1 day (fechaDesde = prior cursor) for safety.
 * - Idempotent via `upsertContract` (keyed by grContratoId); dedup Set per run
 *   prevents double-counting contracts returned by both scans.
 * - Guard: if the owning client doesn't exist yet, `upsertContract` returns
 *   { skipped: true } — counted as skipped, NOT as updated. Recovered in the
 *   next overlap window once client-sync mirrors the client.
 */
export class SyncGestionRealContractsDelta {
  private readonly now: () => Date;
  private readonly pageSize: number;

  constructor(
    private readonly gr: GestionRealPort,
    private readonly mirror: ClientMirrorRepository,
    private readonly state: SyncStateRepository,
    private readonly featureFlags: FeatureFlagRepository,
    opts: { now?: () => Date; pageSize?: number } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  async execute(): Promise<ContractDeltaResult> {
    const flag = await this.featureFlags.get(SYNC_FLAG_KEY);
    if (!flag?.enabled) {
      return { fetched: 0, created: 0, updated: 0, skipped: 0, cursor: '', skippedFlag: true };
    }

    const prior = await this.state.get(SYNC_ENTITY);
    const runDate = formatGrDate(this.now());
    // Bootstrap: no cursor → scan only today (don't back-fill history, that's backfill's job).
    // With cursor → re-scan from last run date (overlap of ≥1 day is intentional, upserts are idempotent).
    const fechaDesde = prior?.cursor ?? runDate;

    let fetched = 0;
    let created = 0;
    let updated = 0;
    let skipped = 0;

    // Two scans: modification date (m) then creation date (c), same window.
    // A contract can appear in both — `processed` deduplicates by grContratoId
    // so counts stay accurate and no contract is upserted twice per run.
    const fechaTipos: ('m' | 'c')[] = ['m', 'c'];
    const processed = new Set<string>();

    try {
      for (const fechaTipo of fechaTipos) {
        let offset = 0;
        while (true) {
          const { total, contracts } = await this.gr.fetchContractsModifiedSince({
            fechaDesde,
            fechaHasta: runDate,
            fechaTipo,
            cantidad: this.pageSize,
            offset,
          });

          for (const contract of contracts) {
            if (processed.has(contract.grContratoId)) continue;
            processed.add(contract.grContratoId);

            const r = await this.mirror.upsertContract(contract);
            fetched++;
            if (r.skipped) {
              // Orphan guard: parent client not yet mirrored. Log as skipped so the
              // delta summary accurately reflects missing-parent skips (not "updates").
              skipped++;
            } else if (r.created) {
              created++;
            } else {
              updated++;
            }
          }

          offset += this.pageSize;
          if (contracts.length === 0 || offset >= total) break;
        }
      }
    } catch (err) {
      await this.state.save({
        entity: SYNC_ENTITY,
        cursor: prior?.cursor ?? null,
        lastRunAt: this.now(),
        lastResult: `error: ${(err as Error).message}`,
        itemsSynced: fetched,
      });
      throw err;
    }

    await this.state.save({
      entity: SYNC_ENTITY,
      cursor: runDate,
      lastRunAt: this.now(),
      lastResult: 'ok',
      itemsSynced: fetched,
    });

    return { fetched, created, updated, skipped, cursor: runDate };
  }
}

/** Date → "DD-MM-AAAA" (GR's expected delta format). */
export function formatGrDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}
