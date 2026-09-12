/**
 * suricata-tickets-mirror — typed domain errors for the shared Playwright
 * session guard (`SuricataSession`, Phase B / design D4). Kept in a dedicated
 * file (molde `messaging-bulk.ts`) — Phase D (verdict) and Phase E (reply) add
 * their own errors here as those capabilities land (`InvalidSuricataVerdictError`,
 * `SuricataTicketNotFoundError` per tasks.md D.3); this file starts with the two
 * errors the session lock itself can raise.
 *
 * HTTP mapping (owned by Phase E task E.3, NOT this phase — the lock mechanism
 * is pure and testable without any route existing yet):
 *   SURICATA_SESSION_BUSY  → 503 + `Retry-After` (reply queued behind sync/another
 *                            replica longer than its budget — the request was
 *                            valid, the shared resource is busy)
 *   SURICATA_UNAVAILABLE   → 502 (re-login failed after one retry — D4: "una
 *                            cuenta ajena bloqueada por martilleo de logins es un
 *                            daño peor que un sync saltado", so this never loops)
 */
import { DomainError } from './index';

/**
 * Raised by `SuricataSession.withSession` when the caller's `timeoutMs` budget
 * expires before the shared session becomes available — either still queued
 * behind in-process work (D4: a `low` priority sync holds the session per work
 * unit, a `high` priority reply jumps the queue but still waits for the unit in
 * flight) or because the cross-replica `PgAdvisoryLock('suricata-session')` is
 * held by another container. Never a validation failure: the request is fine,
 * the resource is temporarily busy.
 */
export class SuricataSessionBusyError extends DomainError {
  constructor(message = 'Suricata session is busy, try again shortly') {
    super(message, 'SURICATA_SESSION_BUSY');
    this.name = 'SuricataSessionBusyError';
  }
}

/**
 * Raised by `ensureAuthenticated` when the DOM-marker classification still
 * reports "not authenticated" AFTER one login attempt and one re-check (D4:
 * single re-login + single retry — never a blind retry loop against a
 * third-party account). The sync marks its run `failed` with this error; the
 * reply flow (Phase E) surfaces it as 502 without writing anything to Suricata.
 */
export class SuricataAuthError extends DomainError {
  constructor(message = 'Could not authenticate against Suricata after retrying login once') {
    super(message, 'SURICATA_UNAVAILABLE');
    this.name = 'SuricataAuthError';
  }
}

/**
 * suricata-tickets-mirror (Phase C, task C.5) — no existe ningún adjunto
 * mirroreado con ese id local. Usado por `markStored`/`markFailed` cuando el
 * id no corresponde a ninguna fila (molde `AttachmentNotFoundError`).
 */
export class SuricataAttachmentNotFoundError extends DomainError {
  constructor(public readonly id: string) {
    super(`Suricata attachment with id ${id} not found`, 'SURICATA_ATTACHMENT_NOT_FOUND');
    this.name = 'SuricataAttachmentNotFoundError';
  }
}

/**
 * suricata-tickets-mirror (Phase C, task C.5) — `finish(id, ...)` recibió un
 * id de corrida que `start()` nunca creó (molde `AttachmentNotFoundError`).
 */
export class SuricataSyncRunNotFoundError extends DomainError {
  constructor(public readonly id: string) {
    super(`Suricata sync run with id ${id} not found`, 'SURICATA_SYNC_RUN_NOT_FOUND');
    this.name = 'SuricataSyncRunNotFoundError';
  }
}

/**
 * suricata-tickets-mirror (Phase D, task D.3, spec VERDICT-2) — `resuelto:
 * false` submitted without `motivo` and/or `respuestaSugerida` (both
 * required in that case, per the spec's conditional requirement). Mapped to
 * 400 (statusMap `SURICATA_VERDICT_INVALID`) — spec.md is explicit: "Any
 * violation MUST respond 400 before persisting anything" (VERDICT-2). This
 * intentionally DIFFERS from design.md D9's illustrative "422
 * VALIDATION_ERROR" — spec.md is the authoritative contract for this
 * endpoint's wire behavior; see the apply-phase deviation note.
 */
export class InvalidSuricataVerdictError extends DomainError {
  constructor(public readonly missingFields: string[]) {
    super(`Invalid Suricata verdict: missing ${missingFields.join(', ')}`, 'SURICATA_VERDICT_INVALID');
    this.name = 'InvalidSuricataVerdictError';
  }
}

/**
 * suricata-tickets-mirror (Phase D, task D.3, spec VERDICT-3) — a verdict was
 * submitted (or an attachment requested, D7.c) for an `externalId` that has
 * no mirrored `SuricataTicket` row. Mapped to 404, nothing persisted.
 */
export class SuricataTicketNotFoundError extends DomainError {
  constructor(public readonly externalId: string) {
    super(`Suricata ticket with externalId ${externalId} not found`, 'SURICATA_TICKET_NOT_FOUND');
    this.name = 'SuricataTicketNotFoundError';
  }
}

/**
 * suricata-tickets-mirror (Phase D, design D0/D7.c) — the external verdict
 * router (verdict submission + attachment content proxy) is gated by the
 * `suricata-verdict-enabled` feature flag, dark by default (D14). Mapped to
 * 403 via the PRE-EXISTING `FEATURE_DISABLED` code (already mapped in
 * `errorHandler.ts`, reused across capabilities — molde
 * `FeatureExternalBulkDisabledError`).
 */
export class SuricataVerdictFeatureDisabledError extends DomainError {
  constructor(message = 'Suricata verdict/attachment capability is disabled') {
    super(message, 'FEATURE_DISABLED');
    this.name = 'SuricataVerdictFeatureDisabledError';
  }
}
