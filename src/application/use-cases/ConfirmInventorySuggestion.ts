import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { InstalledItemType } from '@domain/entities/contract-installed-item';
import {
  SuggestionNotFoundError,
  SuggestionAlreadyConfirmedError,
  TaskHasNoContractError,
} from '@domain/errors/inventory';
import { randomUUID } from 'crypto';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { InstalledItemDto, toInstalledItemDto } from '@application/dto/InstalledItemDto';

const VALID_TYPES: InstalledItemType[] = ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS'];
const toType = (t: string | null): InstalledItemType =>
  t && (VALID_TYPES as string[]).includes(t) ? (t as InstalledItemType) : 'OTROS';

export interface ConfirmInventorySuggestionInput {
  suggestionId: string;
  addedByUserId?: string | null;
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
  ) {}

  async execute(input: ConfirmInventorySuggestionInput): Promise<InstalledItemDto> {
    const suggestion = await this.suggestions.get(input.suggestionId);
    if (!suggestion) throw new SuggestionNotFoundError(input.suggestionId);
    if (suggestion.status === 'confirmed') throw new SuggestionAlreadyConfirmedError(input.suggestionId);

    const task = await this.scheduling.getTask(suggestion.taskId);
    const contractId = task?.contractId ?? null;
    if (!contractId) throw new TaskHasNoContractError(suggestion.taskId);

    const now = new Date().toISOString();
    const item = await this.inventory.create({
      id: randomUUID(),
      contractId,
      type: toType(suggestion.deviceType),
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

    await this.suggestions.setStatus(suggestion.id, 'confirmed', item.id);
    const user = input.addedByUserId ? await this.users.findById(input.addedByUserId) : null;
    return toInstalledItemDto(item, user?.name ?? null);
  }
}
