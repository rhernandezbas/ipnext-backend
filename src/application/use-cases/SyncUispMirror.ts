import type { UispClient } from '@domain/ports/UispClient';
import type { UispSiteRepository } from '@domain/ports/UispSiteRepository';
import type { UispDeviceRepository } from '@domain/ports/UispDeviceRepository';
import type { SyncStateRepository } from '@domain/ports/SyncStateRepository';

export interface SyncUispMirrorResult {
  sitesUpserted: number;
  devicesUpserted: number;
  sitesMissing: number;
  devicesMissing: number;
  sitesReappeared: number;
  devicesReappeared: number;
  durationMs: number;
}

/**
 * SyncUispMirror — pulls sites + devices from UISP and upserts them into the local mirror.
 *
 * Algorithm:
 * 1. Pull sites + devices from UISP (UispClient).
 * 2. Upsert all sites (chunked, sequential — no event loop blocking).
 * 3. Upsert all devices (chunked, sequential).
 * 4. Compute missingSince: items in mirror but NOT in the UISP response.
 * 5. markMissing on vanished items (only if not already missing).
 * 6. clearMissing on reappeared items (present in UISP + had missingSince).
 * 7. Persist SyncState entity='uisp-mirror' with counts + lastResult.
 *
 * IMPORTANT: if UispClient throws UispUnavailableError, this method re-throws immediately
 * without touching the mirror — keeping the last good state intact.
 */
export class SyncUispMirror {
  constructor(
    private readonly client: UispClient,
    private readonly siteRepo: UispSiteRepository,
    private readonly deviceRepo: UispDeviceRepository,
    private readonly syncStateRepo: SyncStateRepository,
  ) {}

  async execute(): Promise<SyncUispMirrorResult> {
    const startedAt = Date.now();

    // 1. Pull from UISP — throws UispUnavailableError if down (mirror stays intact)
    const [sites, devices] = await Promise.all([
      this.client.listSites(),
      this.client.listDevices(),
    ]);

    const syncAt = new Date();

    // 2. Upsert sites (sequential chunks to yield event loop)
    for (const site of sites) {
      await this.siteRepo.upsert({ ...site, lastSyncAt: syncAt });
    }

    // 3. Upsert devices
    for (const device of devices) {
      await this.deviceRepo.upsert({ ...device, lastSyncAt: syncAt });
    }

    // 4-6. missingSince stamp/clear for sites
    // FIX-3: if UISP returned zero sites, skip missing-marking entirely.
    // A 200 with an empty list is more likely a proxy hiccup than genuine site
    // disappearance — marking 4009 items as missing in one tick would be catastrophic.
    const currentSiteIds = new Set(sites.map(s => s.uispId));
    const allStoredSites = await this.siteRepo.listAll();

    let missingSiteIds: string[] = [];
    let reappearedSiteIds: string[] = [];

    if (sites.length > 0) {
      missingSiteIds = allStoredSites
        .filter(s => !currentSiteIds.has(s.uispId) && s.missingSince === null)
        .map(s => s.uispId);

      reappearedSiteIds = allStoredSites
        .filter(s => currentSiteIds.has(s.uispId) && s.missingSince !== null)
        .map(s => s.uispId);

      if (missingSiteIds.length > 0) await this.siteRepo.markMissing(missingSiteIds, syncAt);
      if (reappearedSiteIds.length > 0) await this.siteRepo.clearMissing(reappearedSiteIds);
    } else {
      console.warn('[uisp-sync] WARNING: UISP returned 0 sites — skipping missing-marking for sites (possible truncated response)');
    }

    // 4-6. missingSince stamp/clear for devices
    // FIX-3: if UISP returned zero devices, skip missing-marking entirely (same guard as sites).
    const currentDeviceIds = new Set(devices.map(d => d.uispId));

    let missingDeviceIds: string[] = [];
    let reappearedDeviceIds: string[] = [];

    if (devices.length > 0) {
      // FIX-6d: use deviceRepo.listAll() to catch orphaned devices whose sites no longer exist
      // in either the current response or the stored site set (gap N-2: device outlives its site).
      const allStoredDevices = await this.deviceRepo.listAll();

      missingDeviceIds = allStoredDevices
        .filter(d => !currentDeviceIds.has(d.uispId) && d.missingSince === null)
        .map(d => d.uispId);

      reappearedDeviceIds = allStoredDevices
        .filter(d => currentDeviceIds.has(d.uispId) && d.missingSince !== null)
        .map(d => d.uispId);

      if (missingDeviceIds.length > 0) await this.deviceRepo.markMissing(missingDeviceIds, syncAt);
      if (reappearedDeviceIds.length > 0) await this.deviceRepo.clearMissing(reappearedDeviceIds);
    } else {
      console.warn('[uisp-sync] WARNING: UISP returned 0 devices — skipping missing-marking for devices (possible truncated response)');
    }

    const durationMs = Date.now() - startedAt;

    // 7. Persist SyncState
    const counts = JSON.stringify({
      sites: sites.length,
      devices: devices.length,
      missing: missingSiteIds.length + missingDeviceIds.length,
      durationMs,
    });
    await this.syncStateRepo.save({
      entity: 'uisp-mirror',
      cursor: null,
      lastRunAt: syncAt,
      lastResult: `ok: ${counts}`,
      itemsSynced: sites.length + devices.length,
    });

    return {
      sitesUpserted: sites.length,
      devicesUpserted: devices.length,
      sitesMissing: missingSiteIds.length,
      devicesMissing: missingDeviceIds.length,
      sitesReappeared: reappearedSiteIds.length,
      devicesReappeared: reappearedDeviceIds.length,
      durationMs,
    };
  }
}
