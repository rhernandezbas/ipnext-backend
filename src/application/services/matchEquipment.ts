import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { normalizeSerial } from '@domain/entities/return-suggestion';
import { normMac, normSn } from '@application/services/matchInstalledItem';

/**
 * The physical equipment being added, reduced to the three identity fields the
 * match cares about. Source-agnostic: a task suggestion, a manual "+ Agregar SN",
 * or a PPPoE add all adapt to this shape.
 */
export interface EquipmentCandidate {
  type: string | null;
  serialNumber: string | null;
  mac: string | null;
}

/** Match status + the matched item (full entity so the caller can enrich/revive it). */
export interface EquipmentMatch {
  status: 'same_device' | 'same_type' | null;
  item: ContractInstalledItem | null;
}

/**
 * Computes the match between an equipment candidate and the contract's installed
 * items. Removed-aware precedence (design Decisión 3):
 *
 *   1. same_device over ACTIVE items   (SN or MAC coincides — physical identity)
 *   2. same_device over REMOVED items  (revive)
 *   3. same_type  over ACTIVE items
 *   4. same_type  over REMOVED items
 *   5. null
 *
 * same_device means the candidate shares EITHER the normalized SN OR the normalized
 * MAC with an item → it is the same physical device. same_type means only the device
 * type matches (different/absent identity) → the operator decides (409 upstream).
 *
 * Only `active` and `removed` items participate; `replaced` predecessors are inert
 * (they were retired by a replace and must not block or capture a new add).
 */
export function matchEquipment(
  candidate: EquipmentCandidate,
  items: ContractInstalledItem[],
): EquipmentMatch {
  // W1: normalizeSerial (strips ALL non-alphanumeric) for physical SN identity so
  // 'SN-001' and 'SN001' are the same device. normSn (trim+upper) is for type labels.
  const sn = normalizeSerial(candidate.serialNumber);
  const mac = normMac(candidate.mac);
  const type = normSn(candidate.type); // trim + uppercase only — type labels keep dashes

  const active = items.filter((i) => i.status === 'active');
  const removed = items.filter((i) => i.status === 'removed');

  const sharesIdentity = (i: ContractInstalledItem): boolean =>
    (sn != null && normalizeSerial(i.serialNumber) === sn) ||
    (mac != null && normMac(i.mac) === mac);

  const sameType = (i: ContractInstalledItem): boolean =>
    type != null && normSn(i.type) === type;

  // 1) same_device on active, 2) same_device on removed (revive)
  const deviceActive = active.find(sharesIdentity);
  if (deviceActive) return { status: 'same_device', item: deviceActive };
  const deviceRemoved = removed.find(sharesIdentity);
  if (deviceRemoved) return { status: 'same_device', item: deviceRemoved };

  // 3) same_type on active, 4) same_type on removed
  const typeActive = active.find(sameType);
  if (typeActive) return { status: 'same_type', item: typeActive };
  const typeRemoved = removed.find(sameType);
  if (typeRemoved) return { status: 'same_type', item: typeRemoved };

  return { status: null, item: null };
}
