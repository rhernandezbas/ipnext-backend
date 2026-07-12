import type {
  ChatwootGateway,
  ChatwootConversationDto,
  ChatwootMessageDto,
} from '@domain/ports/ChatwootGateway';

/**
 * messaging-inbox (F1, batch B4) — test double for `ChatwootGateway`. B3 owns the real
 * `HttpChatwootGateway` adapter (infrastructure/adapters/chatwoot/); this fake lets the
 * `GetConversation`/`SendMessage` use-case tests exercise the fetch-on-open sync and the
 * send-window flows WITHOUT mocking axios or touching Prisma (same "test double over the
 * port, not the adapter" convention as `FakeTaskActivityRecorder`, `helpers/FakeTaskActivityRecorder.ts`).
 *
 * Configure behavior by mutating the public fields directly before calling `execute()`.
 */
export class FakeChatwootGateway implements ChatwootGateway {
  /** Keyed by `chatwootConversationId`. Populate before calling `getConversation`/`listConversations`. */
  public conversationsById = new Map<number, ChatwootConversationDto>();
  /** Keyed by `chatwootConversationId`. Populate before calling `listMessages`. */
  public messagesById = new Map<number, ChatwootMessageDto[]>();
  /** Result returned by the NEXT `sendMessage()` call when `failSendMessage` is false. */
  public sendMessageResult: ChatwootMessageDto | null = null;

  public failGetConversation = false;
  public failListMessages = false;
  public failSendMessage = false;

  public sendMessageCalls: Array<{ chatwootConversationId: number; content: string }> = [];

  async listConversations(): Promise<ChatwootConversationDto[]> {
    return Array.from(this.conversationsById.values());
  }

  async getConversation(chatwootConversationId: number): Promise<ChatwootConversationDto> {
    if (this.failGetConversation) throw new Error('fake: Chatwoot unreachable (getConversation)');
    const conv = this.conversationsById.get(chatwootConversationId);
    if (!conv) throw new Error(`fake: no conversation registered for ${chatwootConversationId}`);
    return conv;
  }

  async listMessages(chatwootConversationId: number): Promise<ChatwootMessageDto[]> {
    if (this.failListMessages) throw new Error('fake: Chatwoot unreachable (listMessages)');
    return this.messagesById.get(chatwootConversationId) ?? [];
  }

  async sendMessage(chatwootConversationId: number, content: string): Promise<ChatwootMessageDto> {
    this.sendMessageCalls.push({ chatwootConversationId, content });
    if (this.failSendMessage) throw new Error('fake: Chatwoot unreachable (sendMessage)');
    return (
      this.sendMessageResult ?? {
        id: 999,
        direction: 'outbound',
        content,
        senderName: null,
        createdAt: new Date().toISOString(),
      }
    );
  }

  /** F2 — not consumed by any F1 use case; kept trivial for contract completeness. */
  async searchContact(): Promise<{ id: number; name: string | null; phone: string | null }[]> {
    return [];
  }

  /** Invoked only by the one-shot ops script (B7), never by a use case. */
  async registerWebhook(): Promise<void> {}
}
