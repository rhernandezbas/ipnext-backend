import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';
import { SuggestionMatch } from '@application/dto/TaskInventorySuggestionDto';
import { normalizeSerial } from '@domain/entities/return-suggestion';

/**
 * SN: trim + uppercase ONLY. Used for type/device-type comparison where dashes ARE
 * semantically part of the label (e.g. "ONU-1" ≠ "ONU1"). Do NOT use for physical
 * serial identity matching — use `normalizeSerial` for that (W1 fix).
 */
export const normSn = (v: string | null | undefined): string | null =>
  v == null ? null : v.trim().toUpperCase() || null;

/** MAC: trim + uppercase + strip ':' '-'. '' → null. */
export const normMac = (v: string | null | undefined): string | null => {
  if (v == null) return null;
  const s = v.trim().toUpperCase().replace(/[:\-]/g, '');
  return s || null;
};

/**
 * Typed match result: the status AND the matched item (not just the id),
 * because confirm.replace() needs the full entity to retire it without an extra round-trip.
 */
export interface MatchResult {
  status: 'same_device' | 'same_type' | null;
  item: ContractInstalledItem | null;
}

/**
 * Computes the match between a suggestion and the contract's ACTIVE installed items.
 * Precedence: same_device (SN or MAC coincides) > same_type (same device type, different identity).
 * Only DEVICE suggestions participate; MATERIAL always returns { status: null, item: null }.
 * The CALLER is responsible for passing only active items (status === 'active').
 */
export function matchInstalledItem(
  s: TaskInventorySuggestion,
  activeItems: ContractInstalledItem[],
): MatchResult {
  if (s.kind !== 'DEVICE') return { status: null, item: null };

  // W1: use normalizeSerial (strips ALL non-alphanumeric) for physical SN identity so
  // 'SN-001' and 'SN001' are the same device. normSn (trim+upper only) is kept only
  // for device-type label comparison where dashes are part of the name.
  const sn = normalizeSerial(s.serialNumber);
  const mac = normMac(s.mac);
  const type = normSn(s.deviceType); // trim + uppercase only — type labels keep dashes

  // 1) same_device: physical identity — SN or MAC coincides
  const byIdentity = activeItems.find(
    (i) =>
      (sn != null && normalizeSerial(i.serialNumber) === sn) ||
      (mac != null && normMac(i.mac) === mac),
  );
  if (byIdentity) return { status: 'same_device', item: byIdentity };

  // 2) same_type: same device type, different physical identity
  const byType = type != null ? activeItems.find((i) => normSn(i.type) === type) : undefined;
  if (byType) return { status: 'same_type', item: byType };

  return { status: null, item: null };
}

/** Adapter for the listing DTO: maps MatchResult → SuggestionMatch | null. */
export function toSuggestionMatch(r: MatchResult): SuggestionMatch | null {
  if (r.status == null || r.item == null) return null;
  return { status: r.status, itemId: r.item.id, serial: r.item.serialNumber };
}
