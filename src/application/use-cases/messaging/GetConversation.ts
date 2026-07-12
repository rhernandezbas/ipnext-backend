import type { ConversationRepository, ConversationRecord } from '@domain/ports/ConversationRepository';
import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import type { ChatwootGateway } from '@domain/ports/ChatwootGateway';
import { ConversationNotFoundError } from '@domain/errors/messaging';
import { toConversationListItemDto, type ConversationDetailDto } from '@application/dto/messaging';
import type { GetClientContextByPhone } from './GetClientContextByPhone';

/**
 * GetConversation (F1, design §4, INBOX-2 + CTX-2) — conversation detail with
 * fetch-on-open: a fresh sync against the Chatwoot API on EVERY read, upserted
 * idempotently into the mirror BEFORE composing the response.
 *
 * The ENTIRE sync block (getConversation + listMessages + per-message upsert) is
 * wrapped in one try/catch — any failure is logged and swallowed (INBOX-2 scenario
 * 2: "nunca 500 por esto"). The response ALWAYS reflects the post-attempt mirror
 * snapshot: on sync success that's the refreshed row, on sync failure that's simply
 * the pre-existing row, unchanged — never a hand-rolled merge of the two.
 *
 * `clientContext` is computed via `GetClientContextByPhone` — injected as a
 * collaborator use case (constructor DI), same composition pattern as
 * `CancelTv`/`ListOwnershipCases` wiring other lookups/repos — exactly ONCE per
 * detail read (never per row on the list, design §1's anti-N+1 guard).
 */
export class GetConversation {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: ChatMessageRepository,
    private readonly gateway: ChatwootGateway,
    private readonly getClientContext: GetClientContextByPhone,
  ) {}

  async execute(id: string): Promise<ConversationDetailDto> {
    const existing = await this.conversationRepo.findById(id);
    if (!existing) throw new ConversationNotFoundError(id);

    await this.syncFromChatwoot(existing);

    const snapshot = (await this.conversationRepo.findById(id)) ?? existing;
    const clientContext = await this.getClientContext.execute(snapshot.contactPhone);

    return {
      ...toConversationListItemDto(snapshot),
      canReply: snapshot.canReply,
      clientContext,
    };
  }

  private async syncFromChatwoot(existing: ConversationRecord): Promise<void> {
    try {
      const live = await this.gateway.getConversation(existing.chatwootConversationId);
      await this.conversationRepo.upsertByChatwootId({
        chatwootConversationId: existing.chatwootConversationId,
        contactName: live.contactName,
        contactPhone: live.contactPhone,
        status: live.status,
        canReply: live.canReply,
        lastMessageAt: live.lastActivityAt,
      });

      const liveMessages = await this.gateway.listMessages(existing.chatwootConversationId);
      for (const m of liveMessages) {
        // §7 — activity/template, not persisted. H2 residual — same for a private agent
        // note (`m.private`): the GET path has no other way to filter it out, and letting
        // it through here would leak an internal note into the customer-facing thread.
        if (m.direction === null || m.private === true) continue;
        await this.messageRepo.upsertByChatwootMessageId({
          conversationId: existing.id,
          chatwootMessageId: m.id,
          direction: m.direction,
          content: m.content,
          senderName: m.senderName,
          chatwootCreatedAt: m.createdAt,
        });
      }
    } catch (error) {
      // INBOX-2 — a Chatwoot outage during fetch-on-open MUST NOT fail the read.
      console.error('[messaging] GetConversation fetch-on-open sync failed', {
        conversationId: existing.id,
        chatwootConversationId: existing.chatwootConversationId,
        error,
      });
    }
  }
}
