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
 * suricata-tickets-mirror (fix wave) — el adjunto DECLARA (via `Content-Length`)
 * un tamaño por encima de `SURICATA_MAX_ATTACHMENT_BYTES`. Se corta antes de
 * materializar el body, asi el tope deja de aplicarse recien con los bytes ya
 * en el heap del proceso.
 *
 * `message` = `too_large`, exactamente el mismo `lastError` que ya escribe el
 * chequeo por longitud de buffer en `SyncSuricataTickets`: mismo motivo, dos
 * puntos de deteccion (header primero, buffer como red de contencion cuando el
 * server no declara el tamaño).
 */
export class SuricataAttachmentTooLargeError extends DomainError {
  constructor() {
    super('too_large', 'SURICATA_ATTACHMENT_TOO_LARGE');
    this.name = 'SuricataAttachmentTooLargeError';
  }
}

/**
 * suricata-tickets-mirror (fix wave) — el `href` de un adjunto sale del HTML de
 * un sistema de TERCEROS. `new URL(ref, baseUrl)` IGNORA la base cuando `ref`
 * es absoluta, asi que un DOM comprometido podria apuntar al sidecar (que vive
 * en la red interna `ipnext-net`) contra cualquier host — MinIO, el endpoint de
 * metadata del cloud, lo que sea — y el resultado quedaria persistido y
 * servible por nosotros. Esto corta ese vector ANTES de cualquier fetch.
 *
 * El `message` es EXACTAMENTE `invalid_origin` porque `SyncSuricataTickets`
 * persiste `err.message` crudo en `SuricataAttachment.lastError` (mismo criterio
 * que `too_large`): es un motivo legible en la fila, no una URL hostil filtrada
 * a la DB.
 */
export class SuricataAttachmentInvalidOriginError extends DomainError {
  constructor() {
    super('invalid_origin', 'SURICATA_ATTACHMENT_INVALID_ORIGIN');
    this.name = 'SuricataAttachmentInvalidOriginError';
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

/**
 * suricata-tickets-mirror (Phase E, task E.2/E.3, spec suricata-ticket-reply
 * REPLY-2, design D10) — the caller's two confirmation signals disagree: the
 * server-recomputed sha256 of `body` doesn't match the client-supplied
 * `confirm`. Rejected BEFORE any `SuricataReplyAudit` row is written and
 * BEFORE the shared session is ever touched — a mismatched confirm never
 * reaches the port, by construction.
 */
export class SuricataReplyConfirmationMismatchError extends DomainError {
  constructor(message = 'Reply confirmation does not match the submitted text') {
    super(message, 'REPLY_CONFIRMATION_MISMATCH');
    this.name = 'SuricataReplyConfirmationMismatchError';
  }
}

/**
 * suricata-tickets-mirror (Phase E, design D0/D14) — the internal reply route
 * is gated by the (already-seeded, Phase A migration) `suricata-reply-enabled`
 * flag, dark by default. Reuses `FEATURE_DISABLED`, molde
 * `SuricataVerdictFeatureDisabledError`.
 */
export class SuricataReplyFeatureDisabledError extends DomainError {
  constructor(message = 'Suricata reply capability is disabled') {
    super(message, 'FEATURE_DISABLED');
    this.name = 'SuricataReplyFeatureDisabledError';
  }
}

/**
 * suricata-tickets-mirror (Phase E, task E.1) — CONSERVATIVE GUARD added by
 * this apply session, beyond what design/tasks literally spell out. Phase J
 * (`playwright-core`, the sidecar) does not exist yet, so there is no real
 * `SuricataReplyPort` implementation that could EVER reach a live Suricata
 * session today. `composeSuricataModule` wires `UnavailableSuricataReplyPort`
 * UNCONDITIONALLY until Phase J lands the real Playwright driver — every call
 * fails closed with this error, reusing the SAME code (`SURICATA_UNAVAILABLE`,
 * 502) design D10 already assigns to a failed send. Net effect: even if an
 * operator flips `suricata-reply-enabled` and has `suricata.reply`, this
 * capability physically cannot touch a real customer today — see
 * `UnavailableSuricataReplyPort.ts` for the wiring-level half of this guard.
 */
export class SuricataReplyDriverUnavailableError extends DomainError {
  constructor(message = 'No live Suricata reply driver is wired yet (Phase J pending) — refusing to send') {
    super(message, 'SURICATA_UNAVAILABLE');
    this.name = 'SuricataReplyDriverUnavailableError';
  }
}

/**
 * suricata-tickets-mirror (Phase E, task E.2, design D10) — wraps ANY failure
 * raised while sending (session busy, auth failure, missing driver) so the
 * HTTP layer can surface `replyAuditId` in the body: design D10 — "el error
 * de envío sube... con el replyAuditId en el body, para que el operador pueda
 * mirar el intento". Reuses the ORIGINAL failure's `.code` (so the existing
 * `SURICATA_SESSION_BUSY`/`SURICATA_UNAVAILABLE` status mapping still
 * applies) — this class only ADDS the audit id, it never invents a new wire
 * contract.
 */
export class SuricataReplySendFailedError extends DomainError {
  constructor(
    code: string,
    message: string,
    public readonly replyAuditId: string,
  ) {
    super(message, code);
    this.name = 'SuricataReplySendFailedError';
  }
}
