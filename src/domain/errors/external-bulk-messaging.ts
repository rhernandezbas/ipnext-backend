/**
 * external-bulk-messaging — typed domain errors for the M2M "validate then send"
 * WhatsApp bulk flow (design.md D7.a). Molde `domain/errors/messaging-bulk.ts`.
 *
 * NOT here (reused as-is, molde already registered elsewhere):
 *   - `TemplateNotApprovedError` / `MissingTemplateVariablesError` — reused verbatim
 *     from `domain/errors/messaging-bulk.ts` (D3 — TemplateMessagingPort REUSO).
 *   - `ChatwootUnavailableError` (CHATWOOT_UNAVAILABLE, 503) — reused verbatim from
 *     `domain/errors/messaging.ts`.
 *   - `CampaignNotFoundError` (CAMPAIGN_NOT_FOUND, 404) — reused verbatim from
 *     `domain/errors/messaging-bulk.ts` for STATUS-1's "no revela existencia".
 *   - AUTH-1/2/3 (UNAUTHORIZED, 401) — the api-key middleware responds directly
 *     (molde `apiKeyMiddleware`/HMAC middleware), never through a DomainError.
 *
 * HTTP mapping lives in errorHandler.ts statusMap (single source of truth, D7.a):
 *   FEATURE_DISABLED → 403 · CAP_EXCEEDED → 422 · EMPTY_RECIPIENTS → 422 ·
 *   CHATWOOT_LABEL_NOT_FOUND → 422 · CHATWOOT_LABEL_REQUIRED → 422 (external-labels-required,
 *   VAL-1/SEND-4) · PREVIEW_NOT_FOUND → 404 · PREVIEW_EXPIRED → 410 ·
 *   PREVIEW_ALREADY_CONSUMED → 409 · PREVIEW_PAYLOAD_MISMATCH → 409 ·
 *   IDEMPOTENCY_KEY_CONFLICT → 409 · CAMPAIGN_RUNNER_BUSY → 409 · REPORTER_UNAVAILABLE → 503 ·
 *   INSUFFICIENT_CREDIT → 422 · CREDIT_UNAVAILABLE → 503
 *
 * external-labels-required (LBL-2, decisión del orquestador 2026-09-03): `POST
 * .../labels` sobre un título YA existente NO lanza ningún error de este archivo
 * — responde 200 idempotente `{...existingLabel, created:false}` desde la ruta
 * misma (`external-messaging.routes.ts`). No hay `ChatwootLabelExistsError`.
 */
import { DomainError } from './index';

/**
 * KS-1 — raised by `ValidateExternalBulk`/`SendExternalBulk` when the flag
 * `messaging-external-bulk-enabled` is OFF, absent, or `FeatureFlagRepository.get()`
 * throws (fail-safe to OFF — an error is NEVER interpreted as "flag ON"). The
 * FIRST gate of both flows: zero downstream calls (Chatwoot/DB) when raised.
 */
export class FeatureExternalBulkDisabledError extends DomainError {
  constructor(message = 'External bulk messaging is disabled') {
    super(message, 'FEATURE_DISABLED');
    this.name = 'FeatureExternalBulkDisabledError';
  }
}

/**
 * VAL-1/SEND-1/CONFIG-3 — malformed request body (wrong types, `recipients`
 * empty/non-array, missing `templateRef`/`templateName`, missing `previewId`/
 * `Idempotency-Key`, non-positive-integer config values). Reuses the codebase-wide
 * `VALIDATION_ERROR` code (already mapped to 400 in errorHandler's statusMap, same
 * convention as `InvalidTemplateInputError`/`RoleValidationError`).
 */
export class ExternalBulkValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ExternalBulkValidationError';
  }
}

/**
 * VAL-6/VAL-7 — raised when the batch exceeds `maxPerRequest` (per-request cap)
 * or `remainingToday` (daily cap, D6). `limit` tells the FE/caller WHICH cap
 * tripped; the rest of the fields carry the numbers needed to explain why.
 */
export class CapExceededError extends DomainError {
  public readonly limit: 'perRequest' | 'perDay';
  public readonly maxPerRequest?: number;
  public readonly received?: number;
  public readonly remainingToday?: number;

  constructor(details: {
    limit: 'perRequest' | 'perDay';
    maxPerRequest?: number;
    received?: number;
    remainingToday?: number;
  }) {
    const message =
      details.limit === 'perRequest'
        ? `Batch exceeds the per-request cap (maxPerRequest=${details.maxPerRequest}, received=${details.received})`
        : `Batch exceeds the remaining daily cap (remainingToday=${details.remainingToday})`;
    super(message, 'CAP_EXCEEDED');
    this.name = 'CapExceededError';
    this.limit = details.limit;
    this.maxPerRequest = details.maxPerRequest;
    this.received = details.received;
    this.remainingToday = details.remainingToday;
  }
}

/**
 * VAL-10/D0 step 8 — raised by `ValidateExternalBulk` when EVERY recipient in
 * the batch ended up `invalid` (format/duplicate/opt-out/`variables_faltantes`)
 * — zero `valid` left. Distinct from `EmptySegmentError` (messaging-bulk): this
 * capability has no segment filter, only a per-recipient exclusion outcome.
 * Nothing is persisted.
 */
export class EmptyRecipientsError extends DomainError {
  constructor(message = 'All recipients in the batch were excluded; nothing to validate') {
    super(message, 'EMPTY_RECIPIENTS');
    this.name = 'EmptyRecipientsError';
  }
}

/**
 * external-labels (LBL-2) — raised by `ValidateExternalBulk`/`SendExternalBulk`
 * (VAL-1/SEND-4, delta external-bulk-messaging) when `chatwootLabel` is absent,
 * `null`, or empty/whitespace after `trim`. NOT used by `POST .../labels`
 * (external-labels capability) — that route resolves an already-existing
 * title to a 200 idempotent response (`{...existingLabel, created:false}`,
 * decisión del orquestador 2026-09-03), never a 4xx.
 */
export class ChatwootLabelRequiredError extends DomainError {
  constructor(message = 'chatwootLabel is required') {
    super(message, 'CHATWOOT_LABEL_REQUIRED');
    this.name = 'ChatwootLabelRequiredError';
  }
}

/**
 * VAL-5 — raised when `chatwootLabel` is present but does NOT match any label
 * in the live catalog (`ListChatwootLabels`). The label is NEVER auto-created.
 */
export class ChatwootLabelNotFoundError extends DomainError {
  constructor(label: string) {
    super(`Chatwoot label "${label}" not found in the live catalog`, 'CHATWOOT_LABEL_NOT_FOUND');
    this.name = 'ChatwootLabelNotFoundError';
  }
}

/** SEND-2 — raised when `previewId` does not match any `ExternalBulkPreview`. */
export class PreviewNotFoundError extends DomainError {
  constructor(previewId: string) {
    super(`Preview "${previewId}" not found`, 'PREVIEW_NOT_FOUND');
    this.name = 'PreviewNotFoundError';
  }
}

/**
 * SEND-2 — raised when `now > preview.expiresAt` and the preview was never
 * consumed. Maps to 410 Gone (the resource existed, it's just no longer usable).
 */
export class PreviewExpiredError extends DomainError {
  constructor(previewId: string) {
    super(`Preview "${previewId}" has expired`, 'PREVIEW_EXPIRED');
    this.name = 'PreviewExpiredError';
  }
}

/**
 * SEND-2/D8 — raised when the preview was already consumed by a DIFFERENT
 * `Idempotency-Key` (the replay path for the SAME key+preview is SEND-6, never
 * reaches here), OR when `markConsumed` loses the race for its own preview
 * (D8 — another `send` won `updateMany({consumedAt:null})` first).
 */
export class PreviewAlreadyConsumedError extends DomainError {
  constructor(previewId: string) {
    super(`Preview "${previewId}" was already consumed`, 'PREVIEW_ALREADY_CONSUMED');
    this.name = 'PreviewAlreadyConsumedError';
  }
}

/**
 * SEND-3 — raised when the hash re-computed from the persisted preview does
 * NOT match `preview.payloadHash` (the preview row was mutated in the DB
 * between `validate` and `send`). Never a silent success with stale data.
 */
export class PreviewPayloadMismatchError extends DomainError {
  constructor(previewId: string) {
    super(`Preview "${previewId}" payload hash mismatch`, 'PREVIEW_PAYLOAD_MISMATCH');
    this.name = 'PreviewPayloadMismatchError';
  }
}

/**
 * SEND-7 — raised when the SAME `Idempotency-Key` is reused with a DIFFERENT
 * `previewId` than the one it originally consumed (molde `SendTemplateMessage.ts:116`
 * GUARD-0). The original `Campaign` is left untouched; nothing new is created.
 */
export class IdempotencyKeyConflictError extends DomainError {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency-Key "${idempotencyKey}" was already used with a different previewId`,
      'IDEMPOTENCY_KEY_CONFLICT',
    );
    this.name = 'IdempotencyKeyConflictError';
  }
}

/**
 * SEND-8 — raised when `CampaignRunner.start()` returns `{accepted:false}`
 * (the global lock is held by another run). The `Campaign` ALREADY exists
 * (created + preview consumed) — retrying `send` with the same key+preview
 * resumes it (SEND-6), never creates a second one.
 */
export class CampaignRunnerBusyError extends DomainError {
  public readonly campaignId: string;
  public readonly retryAfterSeconds: number;

  constructor(campaignId: string, retryAfterSeconds = 60) {
    super(`Campaign runner is busy; campaign "${campaignId}" is queued`, 'CAMPAIGN_RUNNER_BUSY');
    this.name = 'CampaignRunnerBusyError';
    this.campaignId = campaignId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * D2/D15 — raised by `SendExternalBulk` when the `api-messaging` system user
 * (bootstrapped UNCONDITIONALLY in `main.ts`, molde `bootstrapSystemUsers`) is
 * not resolvable via `rbacUserRepo.findByLogin('api-messaging')`. A platform
 * misconfiguration, never a caller error — maps to 503 (molde `externalV1.routes.ts`'s
 * inline `REPORTER_UNAVAILABLE` for the ticket-create reporter, promoted here to
 * a typed error since `SendExternalBulk` is a use case, not a route body).
 */
export class ReporterUnavailableError extends DomainError {
  constructor(message = 'System reporter "api-messaging" is not provisioned') {
    super(message, 'REPORTER_UNAVAILABLE');
    this.name = 'ReporterUnavailableError';
  }
}

/**
 * twilio-credit-guard (D3.d/D4.c, CG-SEND-2) — raised ONLY by `SendExternalBulk`
 * (fail-closed gate). In `validate` (`ValidateExternalBulk`) insufficient credit
 * is a WARNING in the 200 response, NEVER this error (CG-VAL-1). `details` for
 * the 422 wire response is assembled IN THE ROUTE (D5.b) — the `errorHandler`
 * global does not serialize fields beyond `{error, code}`.
 */
export class InsufficientCreditError extends DomainError {
  public readonly available: string;
  public readonly estimatedCost: string;
  public readonly currency: string;

  constructor(details: { available: string; estimatedCost: string; currency: string }) {
    super(
      `Insufficient provider credit: ${details.estimatedCost} ${details.currency} needed, ${details.available} available`,
      'INSUFFICIENT_CREDIT',
    );
    this.name = 'InsufficientCreditError';
    this.available = details.available;
    this.estimatedCost = details.estimatedCost;
    this.currency = details.currency;
  }
}

/**
 * twilio-credit-guard (D3.c/D3.d, BAL-4/CG-SEND-3/CRED-2) — molde
 * `ReporterUnavailableError`: platform misconfiguration/unavailability, never a
 * caller error. Raised by `TwilioCreditBalanceGateway` for ANY failure reading
 * the provider balance (timeout, network, 4xx/5xx, malformed body), and by
 * `SendExternalBulk` when ANY input of the fail-closed gate is unusable: rates
 * unreadable, balance unreachable, or the estimate coming back `unknown`.
 *
 * fix wave F1 (R2 #3) — la versión anterior decía que `GetMessagingCredit`
 * también compara monedas. NO lo hace: ese use case solo PROPAGA lo que tire
 * el port (CRED-2). El chequeo de moneda (balance vs `MessagingRatesConfig`)
 * vive en `estimateMessagingCost` (COST-4), y lo convierte en este error
 * únicamente `SendExternalBulk` — en `validate` el mismo mismatch es un
 * `warning` del 200 (CG-VAL-1), nunca un error.
 */
export class CreditUnavailableError extends DomainError {
  constructor(message = 'Provider credit balance is unavailable') {
    super(message, 'CREDIT_UNAVAILABLE');
    this.name = 'CreditUnavailableError';
  }
}
