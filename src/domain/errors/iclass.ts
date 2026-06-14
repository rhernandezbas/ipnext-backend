import { DomainError } from './index';

/** Raised when a task has no projectId but IClass integration requires one. */
export class MissingProjectForIClassError extends DomainError {
  constructor(taskId: string) {
    super(`Task "${taskId}" has no project assigned — IClass requires a project mapping`, 'MISSING_PROJECT_FOR_ICLASS');
    this.name = 'MissingProjectForIClassError';
  }
}

/** Raised when the task's project has no iclassSoTypeId mapping. */
export class MissingIClassMappingError extends DomainError {
  readonly projectTitle: string;
  constructor(projectTitle: string) {
    super(`Project "${projectTitle}" has no IClass SO type mapping`, 'MISSING_ICLASS_MAPPING');
    this.name = 'MissingIClassMappingError';
    this.projectTitle = projectTitle;
  }
}

/**
 * Raised when the task's project has an iclassSoType but it is inactive
 * (was deactivated by a sync). The operator must re-map the project.
 */
export class IClassSoTypeInactiveError extends DomainError {
  readonly iclassSoTypeCode: string;
  constructor(code: string) {
    super(`IClass SO type "${code}" is inactive — re-map the project to an active type`, 'ICLASS_SO_TYPE_INACTIVE');
    this.name = 'IClassSoTypeInactiveError';
    this.iclassSoTypeCode = code;
  }
}

/** Raised when an IClass SO type id is not found in the catalog. */
export class IClassSoTypeNotFoundError extends DomainError {
  constructor(id: string) {
    super(`IClass SO type with id "${id}" not found`, 'ICLASS_SO_TYPE_NOT_FOUND');
    this.name = 'IClassSoTypeNotFoundError';
  }
}

/**
 * Raised when a NetworkSite assignment targets an IClass node that exists but
 * cannot be assigned — it is inactive (deactivated by a sync) or non-selectable
 * (a grouping node like "Main"). `reason` carries the human-readable cause.
 */
export class IClassNodeNotAssignableError extends DomainError {
  readonly nodeCode: string;
  readonly reason: string;
  constructor(code: string, reason: string) {
    super(`IClass node "${code}" is not assignable: ${reason}`, 'ICLASS_NODE_NOT_ASSIGNABLE');
    this.name = 'IClassNodeNotAssignableError';
    this.nodeCode = code;
    this.reason = reason;
  }
}

/** Raised when an IClass result-code id is not found in the catalog (closure mapping). */
export class IClassResultCodeNotFoundError extends DomainError {
  constructor(id: string) {
    super(`IClass result code with id "${id}" not found`, 'ICLASS_RESULT_CODE_NOT_FOUND');
    this.name = 'IClassResultCodeNotFoundError';
  }
}

/** Raised when the customer city does not match any IClass node (microárea). */
export class IClassNodeNotFoundError extends DomainError {
  constructor(city: string) {
    super(`No IClass node matches city "${city}"`, 'ICLASS_NODE_NOT_FOUND');
    this.name = 'IClassNodeNotFoundError';
  }
}

/** Raised when an IClass status code is not found in the catalog (status-sync). */
export class IClassStatusNotFoundError extends DomainError {
  constructor(statusCode: string) {
    super(`IClass status with code "${statusCode}" not found`, 'ICLASS_STATUS_NOT_FOUND');
    this.name = 'IClassStatusNotFoundError';
  }
}

/** Raised when the IClass API is unreachable, errors out (5xx) or auth fails after a retry. */
export class IClassUnavailableError extends DomainError {
  constructor(message = 'IClass API is unavailable') {
    super(message, 'ICLASS_UNAVAILABLE');
    this.name = 'IClassUnavailableError';
  }
}

/**
 * Raised when IClass explicitly rejects the request with business `erros`
 * (e.g. ICLERR_0045 codigoCliente over the char limit). Distinct from
 * IClassUnavailableError: the request reached IClass and was understood but
 * refused — the detail carries the concatenated `code: description` of each error.
 */
export class IClassRejectedError extends DomainError {
  /** Concatenated `code: description` of every IClass error. */
  readonly detail: string;
  constructor(detail: string) {
    super(`IClass rejected the request: ${detail}`, 'ICLASS_REJECTED');
    this.name = 'IClassRejectedError';
    this.detail = detail;
  }
}
