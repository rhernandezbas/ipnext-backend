import { Request, Response, NextFunction } from 'express';
import { DomainError } from '@domain/errors';
import { OrchestratorRejectedError } from '@domain/errors/pppoe';
import { domainErrorToCode } from '@application/util/domainErrorToCode';

/**
 * Maps domain error codes to HTTP status codes. This is the single source of truth
 * for the API's error-to-status contract — production (app.ts) and route tests both
 * exercise THIS handler so the mapping cannot drift out from under the tests.
 */
const statusMap: Record<string, number> = {
  // zones (customer-zones-map)
  ZONE_NOT_FOUND: 404,
  INVALID_POLYGON: 422,
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
  ICLASS_NODE_NOT_ASSIGNABLE: 422,
  ICLASS_REJECTED: 422,
  ICLASS_UNAVAILABLE: 502,
  MISSING_PROJECT_FOR_ICLASS: 422,
  MISSING_ICLASS_MAPPING: 422,
  ICLASS_SO_TYPE_INACTIVE: 422,
  ICLASS_SO_TYPE_NOT_FOUND: 404,
  ICLASS_RESULT_CODE_NOT_FOUND: 404,
  ICLASS_STATUS_NOT_FOUND: 404,
  // IClass OS actions (Ola A + Ola B)
  ICLASS_ACTION_DISABLED: 409,
  ICLASS_TASK_NOT_OPEN: 409,
  ICLASS_ALREADY_CLOSED: 409,
  ICLASS_NO_SERVICE_ORDER: 422,
  ICLASS_TEAM_NOT_ASSIGNABLE: 422,
  AUTHENTICATION_ERROR: 401,
  SPLYNX_UNAVAILABLE: 502,
  // PPPoE enforcement (Fase C): backend de corte inalcanzable.
  ROUTER_UNREACHABLE: 502,
  ORCHESTRATOR_UNREACHABLE: 502,
  // PPPoE management errors
  PPPOE_NOT_FOUND: 404,
  PPPOE_USERNAME_TAKEN: 409,
  PPPOE_ALREADY_ASSOCIATED: 409,
  PPPOE_CONTRACT_ALREADY_HAS_SERVICE: 409,
  PPPOE_PROFILE_REQUIRED: 422,
  PPPOE_INGEST_NOT_SUPPORTED: 422,
  PPPOE_RENAME_NAS_NOT_SUPPORTED: 422,
  // ip-allocator (FindFreeIp)
  NAS_NOT_FOUND: 404,
  NO_POOL_FOR_NAS_TYPE: 404,
  NO_FREE_IP: 422,
  WORKFLOW_NAME_CONFLICT: 409,
  DEFAULT_WORKFLOW_PROTECTED: 409,
  WORKFLOW_IN_USE: 409,
  STAGE_IN_USE: 409,
  STAGE_NAME_CONFLICT: 409,
  // IClass closure → inventory
  SUGGESTION_NOT_FOUND: 404,
  SUGGESTION_ALREADY_CONFIRMED: 409,
  SUGGESTION_INCOMPLETE: 422,
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
  // task-manual-inventory-item
  INVALID_ITEM_TYPE: 422,
  // inventory-technician-stock (EPIC #38 W5a)
  INSUFFICIENT_STOCK: 422,
  ASSET_NOT_AT_DEPOT: 422,
  // retire-with-destination (Cambio B) — asset drifted out of `installed`
  ASSET_NOT_INSTALLED: 409,
  // uisp-integration — used for 404 on GET /sites/:uispId AND 422 on NetworkSite link
  UISP_SITE_NOT_FOUND: 422,
  UISP_UNAVAILABLE: 502,
  // #53 — network task requires a non-blank address
  NETWORK_TASK_ADDRESS_REQUIRED: 422,
  // #54 — network task requires a non-blank iclassCityCode (locality)
  NETWORK_TASK_LOCALITY_REQUIRED: 422,
  // #79 — SLA timer thresholds must satisfy dangerMinutes > warnMinutes
  TICKET_SLA_THRESHOLD_ORDER: 422,
  // task-photos — adjuntos de tarea
  UNSUPPORTED_ATTACHMENT_TYPE: 415,
  TOO_MANY_ATTACHMENTS: 422,
  ATTACHMENT_NOT_FOUND: 404,
  IMAGE_TOO_LARGE: 422,
  STORAGE_NOT_CONFIGURED: 503,
};

/** Express global error-handling middleware. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  // #44 — body-parser raises `entity.too.large` when a request body exceeds the
  // configured limit (e.g. the 8mb path-scoped parser on /api/tickets/:id/comments).
  // Map it to 413 BEFORE the DomainError check so it never falls through to the 500 handler.
  if ((err as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }
  if (err instanceof DomainError) {
    // OrchestratorRejectedError re-envía el status HTTP que devolvió el orchestrator (4xx).
    // El statusMap no puede manejarlo estáticamente porque el status es dinámico.
    const status = err instanceof OrchestratorRejectedError
      ? err.upstreamStatus
      : (statusMap[err.code] ?? 400);
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
