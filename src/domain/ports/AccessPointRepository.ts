import type { AccessPoint } from '@domain/entities/accessPoint';

/** Input for the derived-catalog upsert. Keyed by uispDeviceId (one AP per AP device). */
export interface UpsertAccessPointInput {
  uispDeviceId: string;
  networkSiteId: string | null;
  name: string;
  mac: string | null;
}

export interface AccessPointRepository {
  /**
   * Idempotent upsert keyed by uispDeviceId. Creates a new AccessPoint or updates
   * name/mac/networkSiteId of the existing one. Never deletes.
   */
  upsertByUispDeviceId(input: UpsertAccessPointInput): Promise<AccessPoint>;
  findMany(): Promise<AccessPoint[]>;
  findByNetworkSiteId(networkSiteId: string): Promise<AccessPoint[]>;
  findById(id: string): Promise<AccessPoint | null>;
  /**
   * FIX-2: stamp missingSince on APs whose UISP device vanished (retired). Idempotent —
   * only stamps rows where missingSince is currently null, preserving the original date.
   * Keyed by uispDeviceId. Mirrors UispDeviceRepository.markMissing.
   */
  markMissing(uispDeviceIds: string[], since: Date): Promise<void>;
  /** FIX-2: reset missingSince to null on APs that reappeared in UISP. Keyed by uispDeviceId. */
  clearMissing(uispDeviceIds: string[]): Promise<void>;
}
