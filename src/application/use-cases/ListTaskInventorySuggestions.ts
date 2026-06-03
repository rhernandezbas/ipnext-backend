import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import {
  TaskInventorySuggestionDto,
  toTaskInventorySuggestionDto,
} from '@application/dto/TaskInventorySuggestionDto';
import { matchInstalledItem, toSuggestionMatch } from '@application/services/matchInstalledItem';

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

    // Active-only whitelist: replaced items are history, must not match.
    const items = (await this.inventory.listByContract(contractId)).filter(
      (i) => i.status === 'active',
    );

    return list.map((s) => toTaskInventorySuggestionDto(s, toSuggestionMatch(matchInstalledItem(s, items))));
  }
}
