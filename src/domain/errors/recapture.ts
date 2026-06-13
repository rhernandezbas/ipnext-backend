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
