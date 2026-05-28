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
  FLAG_NOT_FOUND: 404,
  MISSING_REQUIRED_FIELDS: 422,
  ICLASS_NODE_NOT_FOUND: 422,
  ICLASS_REJECTED: 422,
  ICLASS_UNAVAILABLE: 502,
  AUTHENTICATION_ERROR: 401,
  SPLYNX_UNAVAILABLE: 502,
  WORKFLOW_NAME_CONFLICT: 409,
  DEFAULT_WORKFLOW_PROTECTED: 409,
  WORKFLOW_IN_USE: 409,
  STAGE_IN_USE: 409,
  STAGE_NAME_CONFLICT: 409,
  PROJECT_CATEGORY_NAME_CONFLICT: 409,
  PROJECT_CATEGORY_IN_USE: 409,
  PROJECT_TYPE_NAME_CONFLICT: 409,
  PROJECT_TYPE_IN_USE: 409,
  REORDER_SET_MISMATCH: 400,
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
    res.status(status).json(body);
    return;
  }
  console.error('[UNHANDLED ERROR]', err);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}
