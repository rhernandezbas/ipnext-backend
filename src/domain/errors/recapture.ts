import { DomainError } from './index';

export class RecaptureLeadNotFoundError extends DomainError {
  constructor(id: string) {
    super(`RecaptureLead with id "${id}" not found`, 'RECAPTURE_LEAD_NOT_FOUND');
    this.name = 'RecaptureLeadNotFoundError';
  }
}

export class RecaptureLeadAlreadyClaimedError extends DomainError {
  constructor(id: string) {
    super(`RecaptureLead "${id}" is already claimed by another user`, 'RECAPTURE_LEAD_ALREADY_CLAIMED');
    this.name = 'RecaptureLeadAlreadyClaimedError';
  }
}

/**
 * Raised when the assignment target is NOT an allowed recaptación assignee.
 *
 * A user is assignable iff they are ACTIVE, carry AT LEAST ONE role, and NONE
 * of their roles is technical (see TECHNICAL_ROLE_CODES). A user with no roles
 * or with a technical role is rejected. The HTTP layer maps this to 422.
 */
export class RecaptureAssigneeNotAllowedError extends DomainError {
  constructor(public readonly operatorId: string) {
    super(
      `User "${operatorId}" is not an allowed recapture assignee (must have at least one non-technical role)`,
      'RECAPTURE_ASSIGNEE_NOT_ALLOWED',
    );
    this.name = 'RecaptureAssigneeNotAllowedError';
  }
}
