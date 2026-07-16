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
 * Change 3 (templates CRUD) — raised when the provider reports a template does
 * NOT exist (Twilio 404 on `GET`/`DELETE /v1/Content/{sid}`, or the in-memory
 * fake looks up an unknown sid). Distinct from the send-path's treatment of 404
 * as a SYSTEMIC config failure (`TemplateProviderConfigError`, 503): on a CRUD
 * lookup a 404 is a genuine "not found" and must surface as 404, not 503.
 * Maps to 404 in errorHandler's statusMap.
 */
export class TemplateNotFoundError extends DomainError {
  constructor(message = 'Template not found') {
    super(message, 'TEMPLATE_NOT_FOUND');
    this.name = 'TemplateNotFoundError';
  }
}

/**
 * Change 3 (templates CRUD) — raised by `DeleteTemplate` when the template is
 * still referenced as the `templateRef` of at least one ACTIVE campaign
 * (`pending`/`running`). Borrar un template toca Meta/WABA y es IRREVERSIBLE:
 * hacerlo mientras una campaña activa lo usa dejaría esa campaña sin template
 * enviable. El borrado se BLOQUEA (409) y se expone cuántas/cuáles campañas lo
 * retienen. Maps to 409 in errorHandler's statusMap.
 */
export class TemplateInUseByCampaignError extends DomainError {
  /** Ids de las campañas activas que retienen el template (para diagnóstico). */
  public readonly campaignIds: string[];

  constructor(contentSid: string, campaignIds: string[]) {
    super(
      `Template "${contentSid}" is in use by ${campaignIds.length} active campaign(s)`,
      'TEMPLATE_IN_USE',
    );
    this.name = 'TemplateInUseByCampaignError';
    this.campaignIds = campaignIds;
  }
}

/**
 * Change 3 (templates CRUD) — raised by `CreateTemplate`/`SubmitTemplateForApproval`
 * on invalid operator input (body/friendlyName/language vacíos, `category` fuera
 * de {UTILITY, MARKETING, AUTHENTICATION}, `name` que normaliza a vacío). Reusa
 * el código genérico `VALIDATION_ERROR` (ya mapeado a 400 en el statusMap, mismo
 * convenio que `RoleValidationError`/`PppoeTransferValidationError`).
 */
export class InvalidTemplateInputError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'InvalidTemplateInputError';
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

/**
 * manual-recipients (MAN-3) — raised by `CreateCampaign`/`PreviewCampaignSegment`
 * when one or more of the operator-provided `manualClientIds` do NOT resolve to a
 * `Client`. Fail-loud: a manual list is an EXPLICIT inclusion, so a bad id must
 * surface (never dropped in silence). Carries the missing ids so the FE can point
 * to exactly which selections are invalid. Nothing is persisted. Maps to 422
 * (well-formed request referencing non-existent entities — same class as
 * `EMPTY_SEGMENT`/`MISSING_TEMPLATE_VARIABLES`; distinct from `UNFILTERED_SEGMENT`
 * which is a 400 "no criteria at all").
 */
export class ManualRecipientsNotFoundError extends DomainError {
  public readonly missingClientIds: string[];

  constructor(missingClientIds: string[]) {
    super(
      `Manual recipient client id(s) not found: ${missingClientIds.join(', ')}`,
      'MANUAL_RECIPIENTS_NOT_FOUND',
    );
    this.name = 'ManualRecipientsNotFoundError';
    this.missingClientIds = missingClientIds;
  }
}

/**
 * manual-recipients FIX-3 — raised by `resolveCombinedRecipients` (shared by
 * `CreateCampaign`/`PreviewCampaignSegment`) when the NORMALIZED `manualClientIds`
 * list exceeds `MAX_MANUAL_RECIPIENTS`. A manual list is HAND-CURATED (the operator
 * hand-picks specific clients in the composer); a multi-thousand payload is never a
 * legitimate curated list and would balloon the `id IN (...)` batch query toward
 * Postgres's ~65535 bind-parameter ceiling — a raw 500. We reject fail-loud with a
 * clear 4xx BEFORE hitting the DB. Mass sends of thousands go through the SEGMENT
 * filter, NOT the manual list. Maps to 422 (same family as `TOO_MANY_ATTACHMENTS`:
 * well-formed but refused for exceeding a size limit). Nothing is persisted.
 */
export class TooManyManualRecipientsError extends DomainError {
  public readonly received: number;
  public readonly max: number;

  constructor(received: number, max: number) {
    super(
      `Manual recipient list has ${received} ids, exceeding the maximum of ${max}`,
      'TOO_MANY_MANUAL_RECIPIENTS',
    );
    this.name = 'TooManyManualRecipientsError';
    this.received = received;
    this.max = max;
  }
}

/**
 * manual-recipients FIX-4 — raised by the `/api/messaging/bulk` route parser
 * (`toManualClientIds`) when `manualClientIds` is PRESENT but malformed: not an
 * array, or an array carrying a non-string element. Fail-loud contract coherence
 * (MAN-3): a non-string id must NOT be dropped in silence (an id that travels as a
 * number would vanish mute, contradicting the whole feature's philosophy). ABSENT
 * (`undefined`) stays valid (segment-only campaign); empty/whitespace strings are
 * normalization (trimmed away downstream), NOT a contract violation. Reuses the
 * generic `VALIDATION_ERROR` code (→ 400), same convention as
 * `InvalidTemplateInputError`/`RoleValidationError`/`PppoeTransferValidationError`.
 */
export class InvalidManualRecipientsError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'InvalidManualRecipientsError';
  }
}

/**
 * bulk-csv-recipients (CSV-5) — raised by the `/api/messaging/bulk` route parser
 * (`toManualContacts`) when `manualContacts` is PRESENT but malformed: not an
 * array, or an array carrying an item that isn't `{name: string, phone: string}`.
 * Fail-loud (mismo criterio que `InvalidManualRecipientsError`): un item mal
 * tipado NO se descarta en silencio. AUSENTE (`undefined`) sigue siendo válido
 * (segmento/manual-only). Reusa `VALIDATION_ERROR` (→ 400).
 */
export class InvalidManualContactsError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'InvalidManualContactsError';
  }
}

/**
 * node-segment — raised by the router's node/AP parser (`toNodeApFilter`, Zod)
 * when `networkSiteId`/`accessPointId` is PRESENT but not a string (or null).
 * Fail-loud (mismo criterio que `InvalidManualRecipientsError`): un id que
 * viaje como number/objeto NO se descarta en silencio — silenciaría el filtro
 * y la campaña apuntaría a más gente de la que el operador eligió. AUSENTE/
 * null sigue siendo válido (= sin filtro). Reusa `VALIDATION_ERROR` (→ 400).
 */
export class InvalidNodeApFilterError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'InvalidNodeApFilterError';
  }
}

/**
 * bulk-csv-recipients (CSV-5) — raised by `resolveCombinedRecipients` cuando la
 * lista `manualContacts` NORMALIZADA (post trim/descarte de filas ambas-vacías)
 * excede `MAX_MANUAL_CONTACTS`. Cota INDEPENDIENTE de `TooManyManualRecipientsError`
 * (un CSV de miles de contactos NO es una curaduría legítima — mismo razonamiento
 * FIX-3: protege el insert masivo y la memoria del match por teléfono). Rechazo
 * fail-loud ANTES de tocar la DB o el universo de `Client`. Maps to 422.
 */
export class TooManyManualContactsError extends DomainError {
  public readonly received: number;
  public readonly max: number;

  constructor(received: number, max: number) {
    super(
      `Manual contact list has ${received} contacts, exceeding the maximum of ${max}`,
      'TOO_MANY_MANUAL_CONTACTS',
    );
    this.name = 'TooManyManualContactsError';
    this.received = received;
    this.max = max;
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
