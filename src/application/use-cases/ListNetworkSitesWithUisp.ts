import type { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';
import type { UispSiteRepository } from '@domain/ports/UispSiteRepository';
import type { NetworkSite } from '@domain/entities/networkSite';

/**
 * UISP-derived live info joined per NetworkSite.
 * Sourced from the UispSite mirror — never from the live UISP API.
 * null when the NetworkSite has no uispSiteId (not linked).
 */
export interface NetworkSiteUispInfo {
  status: string;
  deviceCount: number;
  outageCount: number;
  lastSyncAt: Date;
  missingSince: Date | null;
}

export interface NetworkSiteWithUisp extends NetworkSite {
  uisp: NetworkSiteUispInfo | null;
}

/**
 * ListNetworkSitesWithUisp — lists all NetworkSites enriched with a `uisp` block
 * resolved from the UispSite mirror by uispSiteId.
 *
 * Resolution is done in one batch (listAll from mirror) to avoid N+1.
 * Guard: requires auth (same as the base ListNetworkSites endpoint — maintained by the router).
 */
export class ListNetworkSitesWithUisp {
  constructor(
    private readonly networkSiteRepo: NetworkSiteRepository,
    private readonly uispSiteRepo: UispSiteRepository,
  ) {}

  async execute(): Promise<NetworkSiteWithUisp[]> {
    const [sites, uispSites] = await Promise.all([
      this.networkSiteRepo.findAll(),
      this.uispSiteRepo.listAll(),
    ]);

    // Build lookup map by uispId — O(1) per site, no N+1
    const uispByUispId = new Map(uispSites.map(u => [u.uispId, u]));

    return sites.map(site => {
      const linked = site.uispSiteId ? uispByUispId.get(site.uispSiteId) ?? null : null;
      return {
        ...site,
        uisp: linked
          ? {
              status: linked.status,
              deviceCount: linked.deviceCount,
              outageCount: linked.outageCount,
              lastSyncAt: linked.lastSyncAt,
              missingSince: linked.missingSince,
            }
          : null,
      };
    });
  }
}
