/**
 * UISP mirror domain entities.
 *
 * Pure domain objects — zero external dependencies.
 * uptime is typed `bigint | null` (seconds can exceed Int32; mapped to string in DTO).
 * uispSiteId on UispDevice is the UISP site UUID — NOT an internal FK.
 */

export interface UispSite {
  id: string;
  uispId: string;
  name: string;
  status: string;
  parentUispId: string | null;
  latitude: number | null;
  longitude: number | null;
  deviceCount: number;
  outageCount: number;
  contact: string | null;
  /** Address from UISP description.address — trimmed, null when absent or blank. */
  address: string | null;
  missingSince: Date | null;
  lastSyncAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export function createUispSite(data: UispSite): UispSite {
  return { ...data };
}

export interface UispDevice {
  id: string;
  uispId: string;
  /** UISP site UUID — intentionally NOT an FK to internal UispSite.id. */
  uispSiteId: string;
  name: string;
  model: string;
  modelName: string | null;
  type: string | null;
  role: string | null;
  mac: string | null;
  ip: string | null;
  firmware: string | null;
  status: string;
  signal: number | null;
  uptime: bigint | null;
  lastSeenAt: Date | null;
  missingSince: Date | null;
  lastSyncAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export function createUispDevice(data: UispDevice): UispDevice {
  return { ...data };
}
