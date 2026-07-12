import type { ConversationRecord } from '@domain/ports/ConversationRepository';
import type { ChatMessageRecord } from '@domain/ports/ChatMessageRepository';

/**
 * messaging-inbox (F1, design §5) — DTOs for the inbox. Never expose the mirror's
 * Prisma-shaped records (`ConversationRecord`/`ChatMessageRecord`) directly through
 * a route or use-case return value — always go through the mappers below.
 */

// ─── Conversation list item ──────────────────────────────────────────────────
// Note the field RENAME vs the mirror row: `ConversationRecord.lastMessagePreview`
// → `preview` on the wire (design §5) — deliberate, not a typo.

export interface ConversationListItemDto {
  id: string;
  contactName: string | null;
  contactPhone: string | null;
  lastMessageAt: string | null;
  preview: string | null;
  status: string;
}

// ─── Client context (CTX-1) ──────────────────────────────────────────────────

export interface ClientContextClientDto {
  id: string;
  name: string;
  status: string;
}

export interface ClientContextDto {
  status: 'matched' | 'unknown' | 'ambiguous';
  clients: ClientContextClientDto[];
}

// ─── Conversation detail (GetConversation, fetch-on-open) ───────────────────

export interface ConversationDetailDto extends ConversationListItemDto {
  canReply: boolean;
  clientContext: ClientContextDto;
}

// ─── Chat message ─────────────────────────────────────────────────────────────

export interface ChatMessageDto {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  senderName: string | null;
  sentAt: string;
}

// ─── Mappers (pure functions of the mirror record) ──────────────────────────

export function toConversationListItemDto(record: ConversationRecord): ConversationListItemDto {
  return {
    id: record.id,
    contactName: record.contactName,
    contactPhone: record.contactPhone,
    lastMessageAt: record.lastMessageAt,
    preview: record.lastMessagePreview,
    status: record.status,
  };
}

export function toChatMessageDto(record: ChatMessageRecord): ChatMessageDto {
  return {
    id: record.id,
    direction: record.direction,
    content: record.content,
    senderName: record.senderName,
    sentAt: record.chatwootCreatedAt,
  };
}
