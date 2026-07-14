/**
 * messaging-bulk (F2) — typed domain errors for the WhatsApp bulk-template send
 * flow (templates, segmentation, campaign creation/send, history). Kept in a
 * separate file from `messaging.ts` (messaging-inbox F1) per tasks.md T2.2 — the
 * two features are related but distinct capabilities.
 *
 * HTTP mapping lives in errorHandler.ts statusMap (single source of truth):
 *   TEMPLATE_PROVIDER_UNAVAILABLE → 503 · TEMPLATE_PROVIDER_MISCONFIGURED → 503 ·
 *   TEMPLATE_SEND_REJECTED → 422 · TEMPLATE_NOT_APPROVED → 422 ·
 *   MISSING_TEMPLATE_VARIABLES → 422 · EMPTY_SEGMENT → 422 ·
 *   CAMPAIGN_NOT_FOUND → 404 · CAMPAIGN_ALREADY_FINISHED → 409
 */
import { DomainError } from './index';

/**
 * Raised by `TemplateMessagingPort` implementations (and propagated by
 * `ListTemplates`/`SendCampaign`) on a TRANSIENT failure talking to the
 * template provider (network/timeout, 429, 5xx, bad credentials on
 * `listTemplates`). Retryable — SendCampaign's backoff loop (SEND-3) reacts to
 * this; ListTemplates just propagates it as a 503.
 */
export class TemplateProviderUnavailableError extends DomainError {
  /** ms suggested by the provider's `Retry-After` header on a 429, when known. */
  public readonly retryAfterMs?: number;

  constructor(message = 'Template provider is unavailable', retryAfterMs?: number) {
    super(message, 'TEMPLATE_PROVIDER_UNAVAILABLE');
    this.name = 'TemplateProviderUnavailableError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Raised when `TemplateMessagingPort.sendTemplate` fails with a non-retryable
 * 4xx (SEND-3, "error no-retryable falla sin reintentar") — terminal for THAT
 * recipient, does NOT abort the rest of the campaign.
 */
export class TemplateSendRejectedError extends DomainError {
  constructor(message = 'Template send was rejected by the provider') {
    super(message, 'TEMPLATE_SEND_REJECTED');
    this.name = 'TemplateSendRejectedError';
  }
}

/**
 * messaging-bulk fix wave (FIX-2) — SYSTEMIC provider auth/config failure
 * (401/403/404, o credenciales/`accountSid` vacíos). A diferencia de
 * `TemplateSendRejectedError` (terminal para UN destinatario, no aborta el
 * lote), esto es una falla que afecta a TODOS los envíos por igual: un token
 * rotado/mal o el proveedor mal configurado NO se arregla saltando al siguiente
 * recipient. `SendCampaign` la deja PROPAGAR (aborta el run) para que la campaña
 * quede `failed` con un motivo claro y los recipients NO consumidos sigan
 * `queued` (re-disparables tras corregir la config) — en vez de quemar los miles
 * de destinatarios a `failed` terminal en silencio.
 *
 * NO es retryable por `sendWithRetry` (solo reintenta `TemplateProviderUnavailableError`).
 */
export class TemplateProviderConfigError extends DomainError {
  constructor(message = 'Template provider is misconfigured (auth/config)') {
    super(message, 'TEMPLATE_PROVIDER_MISCONFIGURED');
    this.name = 'TemplateProviderConfigError';
  }
}

/**
 * CAMP-2 — raised by `CreateCampaign` when `templateRef` does not correspond to
 * an `approved` template (either `pending`/`rejected`, or not found at all in
 * `TemplateMessagingPort.listTemplates()` — treated identically, no evidence of
 * approval). No side effects: nothing is persisted.
 */
export class TemplateNotApprovedError extends DomainError {
  constructor(templateRef: string) {
    super(`Template "${templateRef}" is not approved`, 'TEMPLATE_NOT_APPROVED');
    this.name = 'TemplateNotApprovedError';
  }
}

/**
 * CAMP-3 — raised by `CreateCampaign` when the operator-provided
 * `variablesMap` is missing one or more of the template's declared variables.
 * Carries the missing variable names so the FE can surface exactly what's
 * absent. Extra (undeclared) variables in the map are NOT an error.
 */
export class MissingTemplateVariablesError extends DomainError {
  public readonly missing: string[];

  constructor(missing: string[]) {
    super(`Missing required template variables: ${missing.join(', ')}`, 'MISSING_TEMPLATE_VARIABLES');
    this.name = 'MissingTemplateVariablesError';
    this.missing = missing;
  }
}

/**
 * CAMP-4 — raised by `CreateCampaign` when the resolved segment (after
 * SEG-2/SEG-3/SEG-4 exclusions) has zero recipients. Prevents "phantom"
 * campaigns with no possible effect. Nothing is persisted.
 */
export class EmptySegmentError extends DomainError {
  constructor(message = 'Segment resolves to zero recipients') {
    super(message, 'EMPTY_SEGMENT');
    this.name = 'EmptySegmentError';
  }
}

/**
 * messaging-bulk fix wave 2 (FIX-8) — raised by `PreviewCampaignSegment` and
 * `CreateCampaign` when the segment carries NO real filtering criterion (no
 * non-empty `statuses` AND no meaningful debt floor/ceiling). Such a segment
 * would resolve to the ENTIRE `Client` table (`buildSegmentWhere` → `where:{}`),
 * and the `EMPTY_SEGMENT` guard (0 recipients) would NOT catch it — a bulk
 * campaign must always declare who it targets. Nothing is persisted.
 *
 * Note: `balanceMin: 0` does NOT count as a criterion — with the FIX-12 NULL
 * semantics (floor 0 = include never-synced `balanceDue = null`) it means
 * "everyone". A real floor is `balanceMin > 0`; a `balanceMax` always narrows.
 */
export class UnfilteredSegmentError extends DomainError {
  constructor(
    message = 'Segment has no filtering criteria; a campaign must target a status or a debt range',
  ) {
    super(message, 'UNFILTERED_SEGMENT');
    this.name = 'UnfilteredSegmentError';
  }
}

/** HIST-2 — raised by `GetCampaign` (and any lookup) when the id does not exist. */
export class CampaignNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Campaign with id "${id}" not found`, 'CAMPAIGN_NOT_FOUND');
    this.name = 'CampaignNotFoundError';
  }
}

/**
 * SEND-1 (scenario 2) — raised by `CampaignRunner.start` when invoked against
 * a campaign already in `status: 'done'`. A finished campaign is never
 * re-sent automatically (see tasks.md contradicción #5 — no retry-failed
 * mechanism in v1).
 */
export class CampaignAlreadyFinishedError extends DomainError {
  constructor(campaignId: string) {
    super(`Campaign "${campaignId}" has already finished`, 'CAMPAIGN_ALREADY_FINISHED');
    this.name = 'CampaignAlreadyFinishedError';
  }
}
