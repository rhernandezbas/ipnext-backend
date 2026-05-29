import { IClassPort } from '@domain/ports/IClassPort';
import { IClassResultCodeRepository } from '@domain/ports/IClassResultCodeRepository';

export interface ResultCodeSyncResult {
  synced: number;
  created: number;
  updated: number;
}

/**
 * Syncs the IClass result-code catalog (across SO types) into the local repo.
 * Upsert-only: existing mappings (mappedStageId) are preserved — a re-sync never
 * clears the closure mapping an operator configured. No deactivation step (unlike
 * the SO-type sync) since result codes are referenced by name, not soft-deleted.
 */
export class SyncIClassResultCodes {
  constructor(
    private readonly iclass: IClassPort,
    private readonly repo: IClassResultCodeRepository,
  ) {}

  async execute(): Promise<ResultCodeSyncResult> {
    const entries = await this.iclass.listResultCodes();

    let created = 0;
    let updated = 0;
    for (const entry of entries) {
      const { status } = await this.repo.upsert(entry);
      if (status === 'created') created++;
      else updated++;
    }

    return { synced: entries.length, created, updated };
  }
}
