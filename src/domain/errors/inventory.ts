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

export class MaterialNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Material with id ${id} not found`, 'MATERIAL_NOT_FOUND');
    this.name = 'MaterialNotFoundError';
  }
}

export class MaterialNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A material named "${name}" already exists`, 'MATERIAL_NAME_CONFLICT');
    this.name = 'MaterialNameConflictError';
  }
}

export class MaterialInUseError extends DomainError {
  constructor(public readonly usageCount: number) {
    super(`Material is in use by ${usageCount} consumption record(s)`, 'MATERIAL_IN_USE');
    this.name = 'MaterialInUseError';
  }
}

export class MaterialProtectedError extends DomainError {
  constructor() {
    super('The OTRO material cannot be deleted', 'MATERIAL_PROTECTED');
    this.name = 'MaterialProtectedError';
  }
}

export class InstalledItemNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Installed item ${id} not found`, 'INSTALLED_ITEM_NOT_FOUND');
    this.name = 'InstalledItemNotFoundError';
  }
}

export class InstalledItemAlreadyRemovedError extends DomainError {
  constructor(id: string) {
    super(`Installed item ${id} is already removed/replaced`, 'INSTALLED_ITEM_ALREADY_REMOVED');
    this.name = 'InstalledItemAlreadyRemovedError';
  }
}

export class MaterialConsumptionNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Material consumption ${id} not found`, 'MATERIAL_CONSUMPTION_NOT_FOUND');
    this.name = 'MaterialConsumptionNotFoundError';
  }
}

export class InvalidQuantityError extends DomainError {
  constructor() {
    super('Quantity must be greater than zero', 'INVALID_QUANTITY');
    this.name = 'InvalidQuantityError';
  }
}

export class SuggestionNotConfirmedError extends DomainError {
  constructor(id: string) {
    super(`Inventory suggestion ${id} is not confirmed`, 'SUGGESTION_NOT_CONFIRMED');
    this.name = 'SuggestionNotConfirmedError';
  }
}

export class NotADeviceError extends DomainError {
  constructor(id: string) {
    super(`Inventory suggestion ${id} is not a DEVICE`, 'SUGGESTION_NOT_A_DEVICE');
    this.name = 'NotADeviceError';
  }
}

export class SuggestionNotLinkedError extends DomainError {
  constructor(id: string) {
    super(`Inventory suggestion ${id} has no linked contract item`, 'SUGGESTION_NOT_LINKED');
    this.name = 'SuggestionNotLinkedError';
  }
}

export class DuplicateInstalledItemError extends DomainError {
  constructor(suggestionId: string, public readonly existingItemId: string) {
    super(
      `Suggestion ${suggestionId} matches an already-installed device (${existingItemId})`,
      'DUPLICATE_INSTALLED_ITEM',
    );
    this.name = 'DuplicateInstalledItemError';
  }
}

export class NoReplaceTargetError extends DomainError {
  constructor(suggestionId: string) {
    super(
      `Suggestion ${suggestionId} has no same-type active item to replace`,
      'NO_REPLACE_TARGET',
    );
    this.name = 'NoReplaceTargetError';
  }
}

export class IncompleteSuggestionError extends DomainError {
  constructor(id: string, reason: string) {
    super(`Inventory suggestion ${id} is incomplete: ${reason}`, 'SUGGESTION_INCOMPLETE');
    this.name = 'IncompleteSuggestionError';
  }
}
