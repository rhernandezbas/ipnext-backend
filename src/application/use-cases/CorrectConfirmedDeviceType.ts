import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import {
  SuggestionNotFoundError,
  NotADeviceError,
  SuggestionNotConfirmedError,
  SuggestionNotLinkedError,
  InstalledItemNotFoundError,
} from '@domain/errors/inventory';
import { InstalledItemDto, toInstalledItemDto } from '@application/dto/InstalledItemDto';

export interface CorrectConfirmedDeviceTypeInput {
  suggestionId: string;
  /** Received already UPPERCASE from the route. */
  newType: string;
}

export class CorrectConfirmedDeviceType {
  constructor(
    private readonly suggestions: InventorySuggestionRepository,
    private readonly inventory: ContractInventoryRepository,
  ) {}

  async execute(input: CorrectConfirmedDeviceTypeInput): Promise<InstalledItemDto> {
    // 1. Locate the suggestion
    const s = await this.suggestions.get(input.suggestionId);
    if (!s) throw new SuggestionNotFoundError(input.suggestionId);

    // 2. Only DEVICE suggestions have a "device type" to correct
    if (s.kind !== 'DEVICE') throw new NotADeviceError(input.suggestionId);

    // 3. Must already be confirmed (pending → use confirm flow instead)
    if (s.status !== 'confirmed') throw new SuggestionNotConfirmedError(input.suggestionId);

    // 4. confirmedItemId null = dirty data; no item to synchronise
    if (s.confirmedItemId == null) throw new SuggestionNotLinkedError(input.suggestionId);

    // 5. Update the contract item
    const item = await this.inventory.update(s.confirmedItemId, { type: input.newType });
    if (!item) throw new InstalledItemNotFoundError(s.confirmedItemId);

    // 6. Mirror the new type onto the suggestion (reuse setStatus — preserves status + confirmedItemId)
    await this.suggestions.setStatus(s.id, 'confirmed', s.confirmedItemId, input.newType);

    // 7. Return the updated item DTO (addedByUserName null — refetch brings the real name)
    return toInstalledItemDto(item, null);
  }
}
