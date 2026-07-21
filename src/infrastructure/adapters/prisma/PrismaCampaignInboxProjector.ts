import type {
  CampaignInboxProjector,
  ProjectSentMessageInput,
  ProjectChatwootTemplateSendInput,
} from '@domain/ports/CampaignInboxProjector';
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
    const { recipient, contactName, renderedBody, sentAt } = input;

    // Clave de matcheo = E164 CANÓNICO (recipient.phoneE164, ya es toWhatsAppE164 del
    // Client.phone al crear la campaña). NO normalizePhone (lossy con el "15" embebido
    // → duplicados sistemáticos cross-format: el bulk keyea distinto que el webhook de Chatwoot).
    const conversation = await this.conversationRepo.upsertBulkByPhone(recipient.phoneE164, {
      // bulk-csv-recipients (D6) — `contactName` reemplaza `candidate.name`: mismo
      // dato (Client.name fresco para vinculados), + cubre el crudo (CSV-3).
      contactName,
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

  /**
   * chatwoot-hub-sendpath (D9) — proyección del path ON: upsertea la Conversation
   * por el id REAL de Chatwoot (`upsertByChatwootId`, converge con el eco del
   * webhook `message_created` — MISMA UNIQUE, sin duplicar), proyecta el
   * ChatMessage por `chatwootMessageId` (`upsertByChatwootMessageId`, CHW-4) y
   * preserva el lazo recipient→conversación (etiqueta #1, mismo criterio que
   * `projectSentMessage`).
   */
  async projectChatwootTemplateSend(input: ProjectChatwootTemplateSendInput): Promise<void> {
    const { recipient, contactName, contactPhone, chatwootConversationId, chatwootMessageId, renderedBody, sentAt } =
      input;

    const conversation = await this.conversationRepo.upsertByChatwootId({
      chatwootConversationId,
      contactName,
      contactPhone,
    });

    await this.chatMessageRepo.upsertByChatwootMessageId({
      conversationId: conversation.id,
      chatwootMessageId,
      direction: 'outbound',
      content: renderedBody,
      senderName: null,
      chatwootCreatedAt: sentAt,
    });

    await this.campaignRepo.updateRecipient(recipient.id, { conversationId: conversation.id });
  }
}
