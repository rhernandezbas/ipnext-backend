import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import {
  SuggestionNotFoundError,
  SuggestionAlreadyConfirmedError,
  TaskHasNoContractError,
} from '@domain/errors/inventory';
import { randomUUID } from 'crypto';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { InstalledItemDto, toInstalledItemDto } from '@application/dto/InstalledItemDto';

export interface ConfirmInventorySuggestionInput {
  suggestionId: string;
  addedByUserId?: string | null;
  /** Operator's chosen device type (from the dropdown). Overrides the suggestion's deviceType. */
  typeOverride?: string | null;
}

/**
 * Promotes a staged suggestion to a real ContractInstalledItem on the task's
 * contract. This is the ONLY path scraped/OCR data reaches the contract,
 * and it is operator-driven. ONE suggestion → ONE item (2 routers
 * confirmed = 2 rows). Re-confirming is rejected.
 */
export class ConfirmInventorySuggestion {
  constructor(
    private readonly suggestions: InventorySuggestionRepository,
    private readonly inventory: ContractInventoryRepository,
    private readonly scheduling: SchedulingRepository,
    private readonly users: RbacUserRepository,
    private readonly catalog: DeviceTypeCatalogRepository,
  ) {}

  async execute(input: ConfirmInventorySuggestionInput): Promise<InstalledItemDto> {
    const suggestion = await this.suggestions.get(input.suggestionId);
    if (!suggestion) throw new SuggestionNotFoundError(input.suggestionId);
    if (suggestion.status === 'confirmed') throw new SuggestionAlreadyConfirmedError(input.suggestionId);

    const task = await this.scheduling.getTask(suggestion.taskId);
    const contractId = task?.contractId ?? null;
    if (!contractId) throw new TaskHasNoContractError(suggestion.taskId);

    const valid = new Set(await this.catalog.listActiveNames());
    const toType = (t: string | null): string =>
      t && valid.has(t.toUpperCase()) ? t.toUpperCase() : 'OTROS';

    const now = new Date().toISOString();
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
    return toInstalledItemDto(item, user?.name ?? null);
  }
}
