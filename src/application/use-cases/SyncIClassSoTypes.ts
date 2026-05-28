import { IClassPort } from '@domain/ports/IClassPort';
import { IClassSoTypeRepository } from '@domain/ports/IClassSoTypeRepository';

export interface SyncResult {
  /** Total entries processed (upserted) from IClass. */
  synced: number;
  created: number;
  updated: number;
  reactivated: number;
  deactivated: number;
}

/**
 * Syncs the IClass SO type catalog into the local repository.
 *
 * Flow:
 * 1. Fetch all types from IClass via listServiceOrderTypes().
 * 2. Upsert each entry via repo.upsertByCode(), aggregating created/updated/reactivated.
 * 3. Mark as inactive every entry NOT in the IClass response via repo.markInactiveExcept().
 * 4. Return the summary.
 *
 * Throws IClassUnavailableError if IClass is unreachable (propagated from the port).
 */
export class SyncIClassSoTypes {
  constructor(
    private readonly iclass: IClassPort,
    private readonly repo: IClassSoTypeRepository,
  ) {}

  async execute(): Promise<SyncResult> {
    const entries = await this.iclass.listServiceOrderTypes();

    let created = 0;
    let updated = 0;
    let reactivated = 0;

    for (const entry of entries) {
      const { status } = await this.repo.upsertByCode(entry);
      if (status === 'created') created++;
      else if (status === 'updated') updated++;
      else if (status === 'reactivated') reactivated++;
    }

    const presentCodes = entries.map(e => e.code);
    const deactivated = await this.repo.markInactiveExcept(presentCodes);

    return {
      synced: entries.length,
      created,
      updated,
      reactivated,
      deactivated,
    };
  }
}
