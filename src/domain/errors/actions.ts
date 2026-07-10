/**
 * actions-worklist (W2) — typed domain errors for the ownership-transfer worklist.
 * HTTP mapping lives in errorHandler.ts statusMap (single source of truth):
 *   OWNERSHIP_CASE_NOT_FOUND → 404 · INVALID_CANDIDATE_PICK → 422 ·
 *   INVALID_TARGET_ASSIGNMENT → 422 · INVALID_CASE_TRANSITION → 422 ·
 *   DISMISS_REASON_REQUIRED → 400
 */
import { DomainError } from './index';

export class OwnershipCaseNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Ownership case with id "${id}" not found`, 'OWNERSHIP_CASE_NOT_FOUND');
    this.name = 'OwnershipCaseNotFoundError';
  }
}

/**
 * Raised when a candidate pick is invalid: the case is not `ambiguous`, or the
 * picked contractId is not one of the persisted candidates. No side effects.
 */
export class InvalidCandidatePickError extends DomainError {
  constructor(caseId: string, targetContractId: string) {
    super(
      `Contract "${targetContractId}" is not a valid candidate pick for case "${caseId}" (case must be ambiguous and the id must be in candidates)`,
      'INVALID_CANDIDATE_PICK',
    );
    this.name = 'InvalidCandidatePickError';
  }
}

/**
 * H1b — raised when a set-target on a pending case without target/candidates
 * fails mirror validation: the contract does not exist, is in baja, or belongs
 * to the SAME client as the baja. No side effects.
 */
export class InvalidTargetAssignmentError extends DomainError {
  constructor(caseId: string, targetContractId: string, why: string) {
    super(
      `Contract "${targetContractId}" cannot be assigned as target of case "${caseId}": ${why}`,
      'INVALID_TARGET_ASSIGNMENT',
    );
    this.name = 'InvalidTargetAssignmentError';
  }
}

/** Dismissing a case REQUIRES a non-blank reason (CASE-2). */
export class DismissReasonRequiredError extends DomainError {
  constructor(caseId: string) {
    super(`Dismissing case "${caseId}" requires a non-empty reason`, 'DISMISS_REASON_REQUIRED');
    this.name = 'DismissReasonRequiredError';
  }
}

/** Raised on an invalid status transition (e.g. reopening a case that is not dismissed). */
export class InvalidCaseTransitionError extends DomainError {
  constructor(caseId: string, from: string, to: string) {
    super(`Case "${caseId}" cannot transition from "${from}" to "${to}"`, 'INVALID_CASE_TRANSITION');
    this.name = 'InvalidCaseTransitionError';
  }
}
