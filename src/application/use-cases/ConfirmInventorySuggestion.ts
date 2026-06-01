import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { ServiceInventoryRepository } from '@domain/ports/ServiceInventoryRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ServiceInstalledItem, InstalledItemType } from '@domain/entities/service-installed-item';
import {
  SuggestionNotFoundError,
  SuggestionAlreadyConfirmedError,
  TaskHasNoServiceError,
} from '@domain/errors/inventory';
import { randomUUID } from 'crypto';

const VALID_TYPES: InstalledItemType[] = ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS'];
const toType = (t: string | null): InstalledItemType =>
  t && (VALID_TYPES as string[]).includes(t) ? (t as InstalledItemType) : 'OTROS';

export interface ConfirmInventorySuggestionInput {
  suggestionId: string;
  addedByUserId?: string | null;
}

/**
 * Promotes a staged suggestion to a real ServiceInstalledItem on the task's
 * contract (Service). This is the ONLY path scraped/OCR data reaches the
 * contract, and it is operator-driven. ONE suggestion → ONE item (2 routers
 * confirmed = 2 rows). Re-confirming is rejected.
 */
export class ConfirmInventorySuggestion {
  constructor(
    private readonly suggestions: InventorySuggestionRepository,
    private readonly inventory: ServiceInventoryRepository,
    private readonly scheduling: SchedulingRepository,
  ) {}

  async execute(input: ConfirmInventorySuggestionInput): Promise<ServiceInstalledItem> {
    const suggestion = await this.suggestions.get(input.suggestionId);
    if (!suggestion) throw new SuggestionNotFoundError(input.suggestionId);
    if (suggestion.status === 'confirmed') throw new SuggestionAlreadyConfirmedError(input.suggestionId);

    const task = await this.scheduling.getTask(suggestion.taskId);
    const serviceId = task?.serviceId ?? null;
    if (!serviceId) throw new TaskHasNoServiceError(suggestion.taskId);

    const now = new Date().toISOString();
    const item = await this.inventory.create({
      id: randomUUID(),
      serviceId,
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
    return item;
  }
}
