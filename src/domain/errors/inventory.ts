import { DomainError } from './index';

export class SuggestionNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Inventory suggestion ${id} not found`, 'SUGGESTION_NOT_FOUND');
    this.name = 'SuggestionNotFoundError';
  }
}

export class SuggestionAlreadyConfirmedError extends DomainError {
  constructor(id: string) {
    super(`Inventory suggestion ${id} is already confirmed`, 'SUGGESTION_ALREADY_CONFIRMED');
    this.name = 'SuggestionAlreadyConfirmedError';
  }
}

export class TaskHasNoContractError extends DomainError {
  constructor(taskId: string) {
    super(`Task ${taskId} has no contract to attach inventory to`, 'TASK_HAS_NO_CONTRACT');
    this.name = 'TaskHasNoContractError';
  }
}
