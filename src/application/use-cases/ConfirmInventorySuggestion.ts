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
} from '@domain/errors/inventory';
import { randomUUID } from 'crypto';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { InstalledItemDto, toInstalledItemDto } from '@application/dto/InstalledItemDto';
import { MaterialConsumptionDto, toMaterialConsumptionDto } from '@application/dto/MaterialConsumptionDto';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';

export interface ConfirmInventorySuggestionInput {
  suggestionId: string;
  addedByUserId?: string | null;
  /** Operator's chosen device type (from the dropdown). Overrides the suggestion's deviceType. */
  typeOverride?: string | null;
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

    // ── DEVICE branch (existing behavior preserved) ─────────────────────────
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
