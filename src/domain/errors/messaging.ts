/**
 * messaging-inbox (F1) — typed domain errors for the WhatsApp/Chatwoot inbox.
 * HTTP mapping lives in errorHandler.ts statusMap (single source of truth):
 *   CONVERSATION_NOT_FOUND → 404 · MESSAGING_WINDOW_EXPIRED → 422 ·
 *   CHATWOOT_UNAVAILABLE → 503 · CONVERSATION_PHONE_MISSING → 422
 *
 * INVALID_SIGNATURE/STALE_TIMESTAMP (401) are NOT here: the HMAC middleware
 * responds directly (idioma `apiKeyMiddleware`), never through DomainError.
 */
import { DomainError } from './index';

export class ConversationNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Conversation with id "${id}" not found`, 'CONVERSATION_NOT_FOUND');
    this.name = 'ConversationNotFoundError';
  }
}

/**
 * inbox-template-send (TS-2) — raised by `SendTemplateMessage` when NEITHER
 * `conversation.contactPhoneE164` NOR the `toWhatsAppE164(conversation.contactPhone)`
 * fallback resolve to a usable E164 destination. Distinct from
 * `MessagingWindowExpiredError`: a template CAN be sent outside the 24h window
 * (design D2) — this error is about having no phone to send it TO at all, not
 * about window state. No side effects: `sendTemplate` is never called.
 */
export class ConversationPhoneMissingError extends DomainError {
  constructor(conversationId: string) {
    super(
      `Conversation "${conversationId}" has no resolvable phone number (contactPhoneE164 and contactPhone both unusable)`,
      'CONVERSATION_PHONE_MISSING',
    );
    this.name = 'ConversationPhoneMissingError';
  }
}

/**
 * SEND-2 — raised when the last inbound message of a conversation is older than
 * 24h (or there never was an inbound message). No side effects: SendMessage
 * MUST NOT call Chatwoot when this is thrown.
 */
export class MessagingWindowExpiredError extends DomainError {
  constructor(conversationId: string) {
    super(
      `Messaging window expired for conversation "${conversationId}" (no inbound message within the last 24h)`,
      'MESSAGING_WINDOW_EXPIRED',
    );
    this.name = 'MessagingWindowExpiredError';
  }
}

/**
 * SEND-3/ROB-1 — raised on ANY axios failure (network/timeout/4xx/5xx) talking
 * to the Chatwoot API. The spec defines a single failure outcome for Chatwoot
 * errors; distinguishing a deliberate 4xx from an unreachable 5xx is not a
 * scenario in the spec (see design §3).
 */
export class ChatwootUnavailableError extends DomainError {
  constructor(message = 'Chatwoot API is unavailable') {
    super(message, 'CHATWOOT_UNAVAILABLE');
    this.name = 'ChatwootUnavailableError';
  }
}

/**
 * messaging-inbox-v2 (F1.5, RICH-1 #4) — raised by GetInboxClientContext when
 * `?clientId=` is provided on an `ambiguous` conversation but does NOT belong
 * to that conversation's candidate set (resolved from the contact phone). This
 * guards against `messaging:read` being used to pull a rich context for an
 * arbitrary client id unrelated to the conversation being worked.
 */
export class ClientIdNotACandidateError extends DomainError {
  constructor(clientId: string, conversationId: string) {
    super(`Client "${clientId}" is not a candidate for conversation "${conversationId}"`, 'CLIENT_ID_NOT_A_CANDIDATE');
    this.name = 'ClientIdNotACandidateError';
  }
}

/**
 * messaging-inbox-productivity (F1.5 fase C, STATUS-1) — raised by
 * `SetConversationStatus` when `status` is not one of the three values this
 * endpoint accepts (`open`/`resolved`/`pending`). Reuses the codebase-wide
 * `'VALIDATION_ERROR'` code — already mapped to 400 in errorHandler's
 * statusMap (same convention as `RoleValidationError` in rbacUser.errors.ts).
 */
export class InvalidConversationStatusError extends DomainError {
  constructor(status: string) {
    super(
      `Invalid conversation status: "${status}" (expected one of: open, resolved, pending)`,
      'VALIDATION_ERROR',
    );
    this.name = 'InvalidConversationStatusError';
  }
}
