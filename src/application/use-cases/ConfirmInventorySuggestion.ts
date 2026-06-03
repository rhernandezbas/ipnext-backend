import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { TaskMaterialConsumptionRepository } from '@domain/ports/TaskMaterialConsumptionRepository';
import {
  SuggestionNotFoundError,
  SuggestionAlreadyConfirmedError,
  TaskHasNoContractError,
  DuplicateInstalledItemError,
  NoReplaceTargetError,
  NotADeviceError,
} from '@domain/errors/inventory';
import { randomUUID } from 'crypto';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { InstalledItemDto, toInstalledItemDto } from '@application/dto/InstalledItemDto';
import { MaterialConsumptionDto, toMaterialConsumptionDto } from '@application/dto/MaterialConsumptionDto';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';
import { matchInstalledItem } from '@application/services/matchInstalledItem';

export type SuggestionResolution = 'add' | 'replace' | 'link_existing';

export interface ConfirmInventorySuggestionInput {
  suggestionId: string;
  addedByUserId?: string | null;
  /** Operator's chosen device type (from the dropdown). Overrides the suggestion's deviceType. */
  typeOverride?: string | null;
  /** How to resolve an existing-match conflict. Default: 'add'. */
  resolution?: SuggestionResolution;
}

export type ConfirmResult =
  | { kind: 'DEVICE'; item: InstalledItemDto }
  | { kind: 'MATERIAL'; consumption: MaterialConsumptionDto };

/**
 * Promotes a staged suggestion to a real ContractInstalledItem (DEVICE) or a
 * TaskMaterialConsumption (MATERIAL) on the task's contract. This is the ONLY
 * path scraped/OCR data reaches the contract, and it is operator-driven.
 * ONE suggestion → ONE item/consumption. Re-confirming is rejected.
 */
export class ConfirmInventorySuggestion {
  constructor(
    private readonly suggestions: InventorySuggestionRepository,
    private readonly inventory: ContractInventoryRepository,
    private readonly scheduling: SchedulingRepository,
    private readonly users: RbacUserRepository,
    private readonly catalog: DeviceTypeCatalogRepository,
    private readonly materials: MaterialCatalogRepository,
    private readonly consumptions: TaskMaterialConsumptionRepository,
  ) {}

  async execute(input: ConfirmInventorySuggestionInput): Promise<ConfirmResult> {
    const suggestion = await this.suggestions.get(input.suggestionId);
    if (!suggestion) throw new SuggestionNotFoundError(input.suggestionId);
    if (suggestion.status === 'confirmed') throw new SuggestionAlreadyConfirmedError(input.suggestionId);

    const task = await this.scheduling.getTask(suggestion.taskId);
    const contractId = task?.contractId ?? null;
    if (!contractId) throw new TaskHasNoContractError(suggestion.taskId);

    const now = new Date().toISOString();

    if (suggestion.kind === 'MATERIAL') {
      return this.handleMaterial(suggestion, now, input.addedByUserId ?? null);
    }

    // ── DEVICE branch ─────────────────────────────────────────────────────────
    const resolution = input.resolution ?? 'add';

    // 'replace' is a destructive operation handled by the dedicated replace() method.
    // The route schema prevents it from reaching here, but guard defensively.
    if (resolution === 'replace') {
      throw new Error('Use the replace() method for replace resolution');
    }

    const activeItems = (await this.inventory.listByContract(contractId)).filter(
      (i) => i.status === 'active',
    );
    const match = matchInstalledItem(suggestion, activeItems);

    // same_device: the physical identity is already installed
    if (match.status === 'same_device') {
      if (resolution === 'add') {
        throw new DuplicateInstalledItemError(suggestion.id, match.item!.id);
      }
      // resolution === 'link_existing': link suggestion to the existing item, no creation
      await this.suggestions.setStatus(suggestion.id, 'confirmed', match.item!.id);
      const user = input.addedByUserId ? await this.users.findById(input.addedByUserId) : null;
      return { kind: 'DEVICE', item: toInstalledItemDto(match.item!, user?.name ?? null) };
    }

    // resolution 'link_existing' only makes sense for same_device (same physical identity).
    // If we reach here, no same_device match was found — treat as add.
    // (FE never sends link_existing without same_device, but handle gracefully.)

    // resolution === 'add' with same_type or no match → create (existing behavior, unchanged)
    const valid = new Set(await this.catalog.listActiveNames());
    const toType = (t: string | null): string =>
      t && valid.has(t.toUpperCase()) ? t.toUpperCase() : 'OTROS';

    const effectiveType = toType(input.typeOverride ?? suggestion.deviceType);
    const item = await this.inventory.create({
      id: randomUUID(),
      contractId,
      type: effectiveType,
      serialNumber: suggestion.serialNumber,
      mac: suggestion.mac,
      model: null,
      source: suggestion.source === 'OCR' ? 'OCR' : 'ICLASS',
      sourceTaskId: suggestion.taskId,
      addedByUserId: input.addedByUserId ?? null,
      confirmedAt: now,
      status: 'active',
      notes: null,
      replacesItemId: null, // add never replaces
      createdAt: now,
      updatedAt: now,
    });

    // When the operator picked a type in the dropdown, persist it onto the
    // suggestion too, so the resolved card shows what was confirmed (ANTENA),
    // not the original scan (ONU). Without an override the scan value stays.
    const persistedType = input.typeOverride != null ? effectiveType : undefined;
    await this.suggestions.setStatus(suggestion.id, 'confirmed', item.id, persistedType);
    const user = input.addedByUserId ? await this.users.findById(input.addedByUserId) : null;
    return { kind: 'DEVICE', item: toInstalledItemDto(item, user?.name ?? null) };
  }

  /**
   * Replace the same-type active item with a new one from this suggestion.
   * Requires a same_type match (not same_device — use link_existing for that).
   * Atomicity: retire first (update → replaced), then create. If create fails,
   * a replaced item without a successor is the tolerable state (never two active duplicates).
   */
  async replace(input: {
    suggestionId: string;
    addedByUserId?: string | null;
    typeOverride?: string | null;
  }): Promise<ConfirmResult> {
    const suggestion = await this.suggestions.get(input.suggestionId);
    if (!suggestion) throw new SuggestionNotFoundError(input.suggestionId);
    if (suggestion.status === 'confirmed') throw new SuggestionAlreadyConfirmedError(input.suggestionId);
    if (suggestion.kind !== 'DEVICE') throw new NotADeviceError(input.suggestionId);

    const task = await this.scheduling.getTask(suggestion.taskId);
    const contractId = task?.contractId ?? null;
    if (!contractId) throw new TaskHasNoContractError(suggestion.taskId);

    const activeItems = (await this.inventory.listByContract(contractId)).filter(
      (i) => i.status === 'active',
    );
    const match = matchInstalledItem(suggestion, activeItems);

    // replace requires a same_type target (not same_device — that path uses link_existing)
    if (match.status !== 'same_type') {
      throw new NoReplaceTargetError(input.suggestionId);
    }

    const now = new Date().toISOString();

    // 1) Retire the old item first (safe order: never produces two active items on failure)
    await this.inventory.update(match.item!.id, { status: 'replaced' });

    // 2) Create the new item, linked to the retired one
    const valid = new Set(await this.catalog.listActiveNames());
    const toType = (t: string | null): string =>
      t && valid.has(t.toUpperCase()) ? t.toUpperCase() : 'OTROS';

    const effectiveType = toType(input.typeOverride ?? suggestion.deviceType);
    const item = await this.inventory.create({
      id: randomUUID(),
      contractId,
      type: effectiveType,
      serialNumber: suggestion.serialNumber,
      mac: suggestion.mac,
      model: null,
      source: suggestion.source === 'OCR' ? 'OCR' : 'ICLASS',
      sourceTaskId: suggestion.taskId,
      addedByUserId: input.addedByUserId ?? null,
      confirmedAt: now,
      status: 'active',
      notes: null,
      replacesItemId: match.item!.id, // link to the retired item
      createdAt: now,
      updatedAt: now,
    });

    const persistedType = input.typeOverride != null ? effectiveType : undefined;
    await this.suggestions.setStatus(suggestion.id, 'confirmed', item.id, persistedType);
    const user = input.addedByUserId ? await this.users.findById(input.addedByUserId) : null;
    return { kind: 'DEVICE', item: toInstalledItemDto(item, user?.name ?? null) };
  }

  private async handleMaterial(
    suggestion: TaskInventorySuggestion,
    now: string,
    addedByUserId: string | null,
  ): Promise<ConfirmResult> {
    // Resolve material by canonical UPPERCASE name (create-if-missing, fallback OTRO)
    const desc = (suggestion.materialDesc ?? '').trim();
    const canonical = desc.toUpperCase();
    let material = desc ? await this.materials.getByName(canonical) : null;
    if (!material && desc) {
      material = await this.materials.create({ name: canonical, unit: suggestion.unit ?? null });
    }
    if (!material) {
      material = await this.materials.getByName('OTRO');
    }

    // material is guaranteed non-null now (OTRO must exist in the catalog)
    const mat = material!;

    const consumption = await this.consumptions.create({
      id: randomUUID(),
      taskId: suggestion.taskId,
      materialCatalogId: mat.id,
      // snapshot: preserve original IClass text, not the canonical name
      materialName: desc || mat.name,
      quantity: suggestion.quantity ?? 1,
      unit: suggestion.unit ?? mat.unit,
      notes: null,
      recordedByUserId: addedByUserId,
      createdAt: now,
      updatedAt: now,
    });

    await this.suggestions.setStatus(suggestion.id, 'confirmed', consumption.id);

    const user = addedByUserId ? await this.users.findById(addedByUserId) : null;
    return { kind: 'MATERIAL', consumption: toMaterialConsumptionDto(consumption, user?.name ?? null) };
  }
}
