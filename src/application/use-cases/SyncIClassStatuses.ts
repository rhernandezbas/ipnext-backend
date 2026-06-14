import { IClassPort } from '@domain/ports/IClassPort';
import { IClassStatusCatalogRepository } from '@domain/ports/IClassStatusCatalogRepository';

/** Returned by the sync endpoint: how many status codes were seen / created / updated. */
export interface SyncIClassStatusesResult {
  /** Number of distinct non-empty statusCodes seen in the IClass listing. */
  synced: number;
  /** Entries that did not exist in the catalog and were created (tracked=false). */
  created: number;
  /** Entries that already existed and had their iclassLabel refreshed. */
  updated: number;
}

/**
 * Manual sync of the IClass status catalog.
 *
 * Calls `iclass.listServiceOrders()` over the discovery window (~28d, under the
 * 30d IClass cap) — the same listing the closure scheduler already runs. Collects
 * the distinct (statusCode, statusDescription) pairs seen and upserts them into
 * the catalog (auto-discovery, tracked=false by default). Empty statusCodes are
 * discarded. Existing operator config (displayLabel, color, tracked) is preserved.
 */
export class SyncIClassStatuses {
  /** Discovery window: ~28 days under the IClass 30-day cap. */
  private static readonly DISCOVERY_DAYS = 28;

  constructor(
    private readonly iclass: IClassPort,
    private readonly repo: IClassStatusCatalogRepository,
  ) {}

  async execute(): Promise<SyncIClassStatusesResult> {
    const now = new Date();
    const windowBegin = new Date(now.getTime() - SyncIClassStatuses.DISCOVERY_DAYS * 24 * 60 * 60 * 1000);

    const summaries = await this.iclass.listServiceOrders({
      updatedDateBegin: windowBegin,
      updatedDateEnd: now,
    });

    // Collect distinct statusCodes (latest descricao wins within a single batch).
    const distinct = new Map<string, string>();
    for (const s of summaries) {
      const code = s.statusCode?.trim() ?? '';
      if (!code) continue; // discard empty
      // Last seen description wins (consistent with auto-discovery behavior)
      distinct.set(code, s.statusDescription?.trim() || code);
    }

    let created = 0;
    let updated = 0;
    for (const [statusCode, iclassLabel] of distinct) {
      const { status } = await this.repo.upsertByStatusCode({ statusCode, iclassLabel });
      if (status === 'created') created++;
      else updated++;
    }

    return { synced: distinct.size, created, updated };
  }
}
