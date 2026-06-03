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

export class DeviceTypeNotFoundError extends DomainError {
  constructor(id: string) {
    super(`DeviceType with id ${id} not found`, 'DEVICE_TYPE_NOT_FOUND');
    this.name = 'DeviceTypeNotFoundError';
  }
}

export class DeviceTypeNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A device type named "${name}" already exists`, 'DEVICE_TYPE_NAME_CONFLICT');
    this.name = 'DeviceTypeNameConflictError';
  }
}

export class DeviceTypeInUseError extends DomainError {
  constructor(public readonly itemCount: number) {
    super(`Device type is in use by ${itemCount} installed item(s)`, 'DEVICE_TYPE_IN_USE');
    this.name = 'DeviceTypeInUseError';
  }
}

export class DeviceTypeProtectedError extends DomainError {
  constructor() {
    super('The OTROS device type cannot be deleted', 'DEVICE_TYPE_PROTECTED');
    this.name = 'DeviceTypeProtectedError';
  }
}
