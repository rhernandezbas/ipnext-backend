import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';
import {
  TaskInventorySuggestionDto,
  SuggestionMatch,
  toTaskInventorySuggestionDto,
} from '@application/dto/TaskInventorySuggestionDto';

// ── Normalisation helpers ────────────────────────────────────────────────────

const normSn = (v: string | null | undefined): string | null =>
  v == null ? null : v.trim().toUpperCase() || null;

const normMac = (v: string | null | undefined): string | null => {
  if (v == null) return null;
  const s = v.trim().toUpperCase().replace(/[:\-]/g, '');
  return s || null;
};

/**
 * Compute the match between a suggestion and the contract's active installed items.
 * Priority: same_device (SN or MAC) > same_type.
 * Only DEVICE suggestions participate; MATERIAL always returns null.
 * Only active items (status !== 'removed') are considered.
 */
export function computeMatch(
  s: TaskInventorySuggestion,
  items: ContractInstalledItem[],
): SuggestionMatch | null {
  if (s.kind !== 'DEVICE') return null;

  const sn = normSn(s.serialNumber);
  const mac = normMac(s.mac);
  const type = normSn(s.deviceType); // same norm: trim + uppercase

  // 1) same_device: physical identity — SN or MAC coincides
  const byIdentity = items.find(
    (i) =>
      (sn != null && normSn(i.serialNumber) === sn) ||
      (mac != null && normMac(i.mac) === mac),
  );
  if (byIdentity) {
    return { status: 'same_device', itemId: byIdentity.id, serial: byIdentity.serialNumber };
  }

  // 2) same_type: same device type, different physical identity
  const byType = type != null ? items.find((i) => normSn(i.type) === type) : undefined;
  if (byType) {
    return { status: 'same_type', itemId: byType.id, serial: byType.serialNumber };
  }

  return null;
}

/** Lists the staged inventory suggestions of a task, enriched with a match field. */
export class ListTaskInventorySuggestions {
  constructor(
    private readonly suggestions: InventorySuggestionRepository,
    private readonly inventory: ContractInventoryRepository,
    private readonly scheduling: SchedulingRepository,
  ) {}

  async execute(taskId: string): Promise<TaskInventorySuggestionDto[]> {
    const list = await this.suggestions.listByTask(taskId);

    const task = await this.scheduling.getTask(taskId);
    const contractId = task?.contractId ?? null;

    if (contractId == null) {
      return list.map((s) => toTaskInventorySuggestionDto(s, null));
    }

    const items = (await this.inventory.listByContract(contractId)).filter(
      (i) => i.status !== 'removed',
    );

    return list.map((s) => toTaskInventorySuggestionDto(s, computeMatch(s, items)));
  }
}
