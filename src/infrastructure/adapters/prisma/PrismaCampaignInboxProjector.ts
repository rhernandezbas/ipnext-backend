import type { CampaignInboxProjector, ProjectSentMessageInput } from '@domain/ports/CampaignInboxProjector';
import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import type { CampaignRepository } from '@domain/ports/CampaignRepository';

/**
 * messaging-bulk-inbox (F1, PROYECCIÓN) — adapter que proyecta un envío bulk YA
 * aceptado como rastro en el inbox. NO habla Prisma directo: COMPONE los ports de
 * Conversation/ChatMessage/Campaign (DIP estricto, testeable con fakes in-memory).
 *
 * Idempotente por `recipient.id`:
 *  1. `upsertBulkByPhone` — appendea a la conversación del cliente o crea una `origin:'bulk'`.
 *  2. `upsertBulkMessage` — un ChatMessage `outbound`/`origin:'bulk'` (dedup por `campaignRecipientId`).
 *  3. `updateRecipient({conversationId})` — setea el lazo (etiqueta #1 + traza del link).
 *
 * NO atrapa errores: `SendCampaign` (el caller) es quien AÍSLA la proyección
 * (best-effort) — un throw acá se loguea allá y NUNCA re-marca el recipient `failed`.
 */
export class PrismaCampaignInboxProjector implements CampaignInboxProjector {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly chatMessageRepo: ChatMessageRepository,
    private readonly campaignRepo: CampaignRepository,
  ) {}

  async projectSentMessage(input: ProjectSentMessageInput): Promise<void> {
    const { recipient, candidate, renderedBody, sentAt } = input;

    // Clave de matcheo = E164 CANÓNICO (recipient.phoneE164, ya es toWhatsAppE164 del
    // Client.phone al crear la campaña). NO normalizePhone (lossy con el "15" embebido
    // → duplicados sistemáticos cross-format: el bulk keyea distinto que el webhook de Chatwoot).
    const conversation = await this.conversationRepo.upsertBulkByPhone(recipient.phoneE164, {
      contactName: candidate.name,
      contactPhone: recipient.phoneE164,
      // El bulk es un mensaje outbound recién enviado → bumpea el preview del inbox.
      lastMessageAt: sentAt,
      lastMessagePreview: renderedBody,
    });

    await this.chatMessageRepo.upsertBulkMessage({
      conversationId: conversation.id,
      campaignRecipientId: recipient.id,
      content: renderedBody,
      chatwootCreatedAt: sentAt,
    });

    await this.campaignRepo.updateRecipient(recipient.id, { conversationId: conversation.id });
  }
}
