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

export class InvalidItemTypeError extends DomainError {
  constructor(type: string) {
    super(`Device type "${type}" is not valid`, 'INVALID_ITEM_TYPE');
    this.name = 'InvalidItemTypeError';
  }
}

// ── Inventory Foundation (EPIC #38, Wave 1) ───────────────────────────────────

/** A consumable decrement would drive MaterialStock.qty below zero. */
export class InsufficientStockError extends DomainError {
  constructor(materialCatalogId: string, available: number, requested: number) {
    super(
      `Insufficient stock for material ${materialCatalogId}: have ${available}, requested ${requested}`,
      'INSUFFICIENT_STOCK',
    );
    this.name = 'InsufficientStockError';
  }
}

/** A movement violates the XOR (asset vs material+qty) shape or the qty>0 guard. */
export class InconsistentMovementError extends DomainError {
  constructor(reason: string) {
    super(`Inconsistent inventory movement: ${reason}`, 'INCONSISTENT_MOVEMENT');
    this.name = 'InconsistentMovementError';
  }
}

/** A second InventoryAsset with an already-used serialNumber was attempted. */
export class DuplicateSerialNumberError extends DomainError {
  constructor(serialNumber: string) {
    super(`An asset with serialNumber "${serialNumber}" already exists`, 'DUPLICATE_SERIAL_NUMBER');
    this.name = 'DuplicateSerialNumberError';
  }
}

/** The referenced deviceType is not in the DeviceTypeCatalog. */
export class UnknownDeviceTypeError extends DomainError {
  constructor(deviceTypeId: string) {
    super(`Device type ${deviceTypeId} is not in the catalog`, 'UNKNOWN_DEVICE_TYPE');
    this.name = 'UnknownDeviceTypeError';
  }
}

/** An asset status transition is not allowed by the lifecycle map. */
export class InvalidStatusTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(`Invalid asset status transition: ${from} → ${to}`, 'INVALID_STATUS_TRANSITION');
    this.name = 'InvalidStatusTransitionError';
  }
}

/** A mutation/delete was attempted on an immutable InventoryMovement ledger row. */
export class MovementImmutableError extends DomainError {
  constructor() {
    super('InventoryMovement records are immutable and cannot be updated or deleted', 'MOVEMENT_IMMUTABLE');
    this.name = 'MovementImmutableError';
  }
}

/** A StockLocation was created with a type outside DEPOSITO|CLIENTE|TECNICO. */
export class InvalidLocationTypeError extends DomainError {
  constructor(type: string) {
    super(`Location type "${type}" is not valid`, 'INVALID_LOCATION_TYPE');
    this.name = 'InvalidLocationTypeError';
  }
}

/** A typed location is missing its required FK (CLIENTE→contractId, TECNICO→technicianId). */
export class MissingLocationFkError extends DomainError {
  constructor(type: string, fk: string) {
    super(`Location type ${type} requires ${fk}`, 'MISSING_LOCATION_FK');
    this.name = 'MissingLocationFkError';
  }
}

/** A second MaterialStock for an existing (materialCatalogId, locationId) was attempted. */
export class DuplicateMaterialStockError extends DomainError {
  constructor(materialCatalogId: string, locationId: string) {
    super(
      `MaterialStock already exists for material ${materialCatalogId} at location ${locationId}`,
      'DUPLICATE_MATERIAL_STOCK',
    );
    this.name = 'DuplicateMaterialStockError';
  }
}

// ── Inventory Foundation (EPIC #38, Wave 2 — atomicity + integration) ─────────

/**
 * Fix #2: a dual-write tried to reuse a serialNumber that belongs to an asset
 * already `installed` at a DIFFERENT contract's location. Reusing it would
 * silently relocate someone else's installed device — so we refuse.
 */
export class AssetInstalledElsewhereError extends DomainError {
  constructor(
    public readonly serialNumber: string,
    public readonly currentLocationId: string,
  ) {
    super(
      `Asset with serialNumber "${serialNumber}" is already installed elsewhere (location ${currentLocationId})`,
      'ASSET_INSTALLED_ELSEWHERE',
    );
    this.name = 'AssetInstalledElsewhereError';
  }
}

/**
 * Fix #5: a DEVICE confirm could not resolve its deviceType NAME to a catalog
 * row and OTROS was not present either. We refuse rather than write the raw
 * NAME into the deviceTypeId FK column (a corrupt-FK footgun).
 */
export class UnresolvableDeviceTypeError extends DomainError {
  constructor(typeName: string) {
    super(
      `Device type "${typeName}" could not be resolved to a catalog id and OTROS fallback is missing`,
      'UNRESOLVABLE_DEVICE_TYPE',
    );
    this.name = 'UnresolvableDeviceTypeError';
  }
}
