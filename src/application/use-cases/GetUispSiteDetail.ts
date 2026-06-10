import type { UispSiteRepository } from '@domain/ports/UispSiteRepository';
import type { UispDeviceRepository } from '@domain/ports/UispDeviceRepository';
import type { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';
import { UispSiteNotFoundError } from '@domain/errors/uisp';

/** Linked NetworkSite summary — returned as part of the UISP site detail. */
export interface LinkedNetworkSite {
  id: string;
  name: string;
}

export interface UispSiteDetail {
  uispId: string;
  name: string;
  status: string;
  parentUispId: string | null;
  latitude: number | null;
  longitude: number | null;
  contact: string | null;
  deviceCount: number;
  outageCount: number;
  lastSyncAt: Date;
  missingSince: Date | null;
  /**
   * NEW — LOUDLY DECLARED in contract:
   * The NetworkSite linked to this UISP site (reverse lookup by uispSiteId = uispId).
   * null when no NetworkSite has been linked.
   */
  linkedNetworkSite: LinkedNetworkSite | null;
}

export interface UispDeviceRow {
  uispId: string;
  name: string;
  model: string;
  modelName: string | null;
  type: string | null;
  role: string | null;
  status: string;
  signal: number | null;
  /** uptime in seconds as string (BigInt → string to avoid JSON serialization errors). */
  uptime: string | null;
  ip: string | null;
  mac: string | null;
  firmware: string | null;
  lastSeenAt: Date | null;
  missingSince: Date | null;
}

export interface GetUispSiteDetailResult {
  site: UispSiteDetail;
  devices: UispDeviceRow[];
}

/**
 * GetUispSiteDetail — returns full site info + device list for a given uispId.
 * uptime BigInt → string in DTO to avoid JSON.stringify failures.
 * Throws UispSiteNotFoundError (→ 404) when uispId not in mirror.
 *
 * NEW: also returns linkedNetworkSite {id, name} | null via a reverse lookup
 * on NetworkSiteRepository.findByUispSiteId(uispId).
 */
export class GetUispSiteDetail {
  constructor(
    private readonly siteRepo: UispSiteRepository,
    private readonly deviceRepo: UispDeviceRepository,
    private readonly networkSiteRepo: NetworkSiteRepository | null = null,
  ) {}

  async execute(uispId: string): Promise<GetUispSiteDetailResult> {
    const site = await this.siteRepo.findByUispId(uispId);
    if (!site) throw new UispSiteNotFoundError(uispId);

    const devices = await this.deviceRepo.listBySiteId(uispId);

    // Reverse lookup: find any NetworkSite whose uispSiteId == this uispId
    let linkedNetworkSite: LinkedNetworkSite | null = null;
    if (this.networkSiteRepo) {
      const ns = await this.networkSiteRepo.findByUispSiteId(uispId);
      if (ns) {
        linkedNetworkSite = { id: ns.id, name: ns.name };
      }
    }

    return {
      site: {
        uispId: site.uispId,
        name: site.name,
        status: site.status,
        parentUispId: site.parentUispId,
        latitude: site.latitude,
        longitude: site.longitude,
        contact: site.contact,
        deviceCount: site.deviceCount,
        outageCount: site.outageCount,
        lastSyncAt: site.lastSyncAt,
        missingSince: site.missingSince,
        linkedNetworkSite,
      },
      devices: devices.map(d => ({
        uispId: d.uispId,
        name: d.name,
        model: d.model,
        modelName: d.modelName,
        type: d.type,
        role: d.role,
        status: d.status,
        signal: d.signal,
        // BigInt → string to avoid JSON.stringify crash (JSON has no BigInt support)
        uptime: d.uptime != null ? d.uptime.toString() : null,
        ip: d.ip,
        mac: d.mac,
        firmware: d.firmware,
        lastSeenAt: d.lastSeenAt,
        missingSince: d.missingSince,
      })),
    };
  }
}
