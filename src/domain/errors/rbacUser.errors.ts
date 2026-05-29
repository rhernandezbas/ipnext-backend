import { DomainError } from './index';

export class UserNotFoundError extends DomainError {
  constructor(id: string) {
    super(`RbacUser with id ${id} not found`, 'USER_NOT_FOUND');
    this.name = 'UserNotFoundError';
  }
}

export class LoginAlreadyTakenError extends DomainError {
  constructor(login: string) {
    super(`Login "${login}" is already taken`, 'LOGIN_ALREADY_TAKEN');
    this.name = 'LoginAlreadyTakenError';
  }
}

export class EmailAlreadyTakenError extends DomainError {
  constructor(email: string) {
    super(`Email "${email}" is already taken`, 'EMAIL_ALREADY_TAKEN');
    this.name = 'EmailAlreadyTakenError';
  }
}

export class RoleNotFoundError extends DomainError {
  constructor(id: string) {
    super(`RbacRole with id ${id} not found`, 'ROLE_NOT_FOUND');
    this.name = 'RoleNotFoundError';
  }
}

export class AtLeastOneRoleRequiredError extends DomainError {
  constructor() {
    super('At least one role must be assigned to the user', 'AT_LEAST_ONE_ROLE_REQUIRED');
    this.name = 'AtLeastOneRoleRequiredError';
  }
}

export class PasswordTooShortError extends DomainError {
  constructor() {
    super('Password must be at least 8 characters long', 'PASSWORD_TOO_SHORT');
    this.name = 'PasswordTooShortError';
  }
}

export class CannotDeleteSelfError extends DomainError {
  constructor() {
    super('You cannot delete your own account', 'CANNOT_DELETE_SELF');
    this.name = 'CannotDeleteSelfError';
  }
}

export class CannotRemoveLastSuperAdminError extends DomainError {
  constructor() {
    super(
      'Cannot remove the last super_admin — assign another super_admin first',
      'CANNOT_REMOVE_LAST_SUPER_ADMIN',
    );
    this.name = 'CannotRemoveLastSuperAdminError';
  }
}

export class InvalidOldPasswordError extends DomainError {
  constructor() {
    super('The provided old password is incorrect or missing', 'INVALID_OLD_PASSWORD');
    this.name = 'InvalidOldPasswordError';
  }
}

export class SuperAdminImmutableError extends DomainError {
  constructor() {
    super('super_admin permissions are managed by the system', 'SUPER_ADMIN_IMMUTABLE');
    this.name = 'SuperAdminImmutableError';
  }
}

export class InvalidPermissionIdsError extends DomainError {
  constructor(unknownIds: string[]) {
    super(`Unknown permission IDs: ${unknownIds.join(', ')}`, 'INVALID_PERMISSION_IDS');
    this.name = 'InvalidPermissionIdsError';
  }
}

export class RoleCodeTakenError extends DomainError {
  constructor(code: string) {
    super(`Role code "${code}" is already taken`, 'ROLE_CODE_TAKEN');
    this.name = 'RoleCodeTakenError';
  }
}

export class RoleIsSystemError extends DomainError {
  constructor(id: string) {
    super(`Role with id ${id} is a system role and cannot be deleted`, 'ROLE_IS_SYSTEM');
    this.name = 'RoleIsSystemError';
  }
}

export class RoleValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'RoleValidationError';
  }
}
