/**
 * AccessPoint domain entity.
 *
 * Pure domain object — zero external dependencies.
 *
 * A derived catalog entry for a UISP device with role='ap'. Auto-seeded by
 * SyncUispMirror from the UispDevice mirror; NOT hand-editable. Links to its
 * NetworkSite (nodo) via networkSiteId. Powers the Bulk WhatsApp F2/F3
 * segmentation by node/AP.
 */
export interface AccessPoint {
  id: string;
  /** UISP device UUID (UispDevice.uispId) — the upsert key. */
  uispDeviceId: string;
  /** FK to NetworkSite.id, resolved by UispDevice.uispSiteId. Null when the node is unknown. */
  networkSiteId: string | null;
  name: string;
  mac: string | null;
  /**
   * FIX-2: retired-AP marker. Stamped by SyncUispMirror (step 9) when the AP's UISP
   * device vanishes from the mirror or drops its role='ap'. Null while the AP is live.
   * Mirrors UispDevice.missingSince. The catalog is never physically deleted; Fase B's
   * assignment selector filters out APs with missingSince !== null.
   */
  missingSince: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function createAccessPoint(data: AccessPoint): AccessPoint {
  return { ...data };
}
