import type { UispSiteRepository } from '@domain/ports/UispSiteRepository';

export interface UispSiteRow {
  uispId: string;
  name: string;
  status: string;
  deviceCount: number;
  outageCount: number;
  lastSyncAt: Date;
  missingSince: Date | null;
}

export interface ListUispSitesResult {
  sites: UispSiteRow[];
}

/**
 * ListUispSites — reads all sites from the UISP mirror.
 * Returns the UispSiteRow wire contract (subset of fields for the list view).
 * status:"unknown" is a normal UISP polling state — served as-is.
 */
export class ListUispSites {
  constructor(private readonly siteRepo: UispSiteRepository) {}

  async execute(): Promise<ListUispSitesResult> {
    const sites = await this.siteRepo.listAll();
    return {
      sites: sites.map(s => ({
        uispId: s.uispId,
        name: s.name,
        status: s.status,
        deviceCount: s.deviceCount,
        outageCount: s.outageCount,
        lastSyncAt: s.lastSyncAt,
        missingSince: s.missingSince,
      })),
    };
  }
}
