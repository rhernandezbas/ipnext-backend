import { Request, Response, NextFunction } from 'express';
import { DomainError } from '@domain/errors';
import { domainErrorToCode } from '@application/util/domainErrorToCode';

/**
 * Maps domain error codes to HTTP status codes. This is the single source of truth
 * for the API's error-to-status contract — production (app.ts) and route tests both
 * exercise THIS handler so the mapping cannot drift out from under the tests.
 */
const statusMap: Record<string, number> = {
  CLIENT_NOT_FOUND: 404,
  TICKET_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  STAGE_NOT_FOUND: 404,
  WORKFLOW_NOT_FOUND: 404,
  PROJECT_CATEGORY_NOT_FOUND: 404,
  PROJECT_TYPE_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  FLAG_NOT_FOUND: 404,
  MISSING_REQUIRED_FIELDS: 422,
  ICLASS_NODE_NOT_FOUND: 422,
  ICLASS_REJECTED: 422,
  ICLASS_UNAVAILABLE: 502,
  MISSING_PROJECT_FOR_ICLASS: 422,
  MISSING_ICLASS_MAPPING: 422,
  ICLASS_SO_TYPE_INACTIVE: 422,
  ICLASS_SO_TYPE_NOT_FOUND: 404,
  ICLASS_RESULT_CODE_NOT_FOUND: 404,
  AUTHENTICATION_ERROR: 401,
  SPLYNX_UNAVAILABLE: 502,
  WORKFLOW_NAME_CONFLICT: 409,
  DEFAULT_WORKFLOW_PROTECTED: 409,
  WORKFLOW_IN_USE: 409,
  STAGE_IN_USE: 409,
  STAGE_NAME_CONFLICT: 409,
  // IClass closure → inventory
  SUGGESTION_NOT_FOUND: 404,
  SUGGESTION_ALREADY_CONFIRMED: 409,
  TASK_HAS_NO_SERVICE: 409,
  TASK_HAS_NO_CONTRACT: 409,
  PROJECT_CATEGORY_NAME_CONFLICT: 409,
  PROJECT_CATEGORY_IN_USE: 409,
  PROJECT_TYPE_NAME_CONFLICT: 409,
  PROJECT_TYPE_IN_USE: 409,
  REORDER_SET_MISMATCH: 400,
  // SDD #2 — RbacUser management error codes
  USER_NOT_FOUND: 404,
  ROLE_NOT_FOUND: 404,
  LOGIN_ALREADY_TAKEN: 409,
  EMAIL_ALREADY_TAKEN: 409,
  PASSWORD_TOO_SHORT: 400,
  AT_LEAST_ONE_ROLE_REQUIRED: 400,
  CANNOT_DELETE_SELF: 403,
  CANNOT_REMOVE_LAST_SUPER_ADMIN: 403,
  INVALID_OLD_PASSWORD: 403,
  // SDD #3 Phase 4a — role-permissions routes error codes
  SUPER_ADMIN_IMMUTABLE: 400,
  INVALID_PERMISSION_IDS: 400,
  // SDD #3 Phase 4b — role catalog mutation routes error codes
  ROLE_CODE_TAKEN: 409,
  ROLE_IS_SYSTEM: 403,
  VALIDATION_ERROR: 400,
  // SDD #5 — sessions
  SESSION_NOT_FOUND: 404,
  // SDD #6a — auth hardening
  ACCOUNT_LOCKED: 423,
  RATE_LIMITED: 429,
  PASSWORD_POLICY: 400,
  // inventory-confirm-dedup-replace
  DUPLICATE_INSTALLED_ITEM: 409,
  NO_REPLACE_TARGET: 409,
};

/** Express global error-handling middleware. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof DomainError) {
    const status = statusMap[err.code] ?? 400;
    const mapped = domainErrorToCode(err);
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    // Surface the missing field names so the front-end can drive its modal.
    if (mapped?.missingFields !== undefined) {
      body['missingFields'] = mapped.missingFields;
    }
    // Surface the IClass rejection detail (e.g. ICLERR_0045 ...) for the front-end.
    if (mapped?.reason !== undefined) {
      body['reason'] = mapped.reason;
    }
    // Surface projectTitle so the FE can render "Project «title» has no mapping".
    if (mapped?.projectTitle !== undefined) {
      body['projectTitle'] = mapped.projectTitle;
    }
    // Surface iclassSoTypeCode so the FE can render "Type «code» was deactivated".
    if (mapped?.iclassSoTypeCode !== undefined) {
      body['iclassSoTypeCode'] = mapped.iclassSoTypeCode;
    }
    res.status(status).json(body);
    return;
  }
  console.error('[UNHANDLED ERROR]', err);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}
