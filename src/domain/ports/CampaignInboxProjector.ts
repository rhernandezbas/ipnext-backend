import type { CampaignRecipient } from '../entities/campaign';

/**
 * messaging-bulk-inbox (F1, PROYECCIÓN) — port que proyecta un envío bulk YA
 * ACEPTADO por el proveedor como rastro en el inbox (Conversation + ChatMessage
 * outbound) y setea `recipient.conversationId` (lazo de la etiqueta #1).
 *
 * El use case `SendCampaign` depende de ESTE port (nunca de Prisma/infra — DIP
 * estricto), inyectado como 5º arg OPCIONAL. La implementación
 * (`PrismaCampaignInboxProjector`) compone los repos de Conversation/ChatMessage/
 * Campaign. Un fake in-memory lo cubre en tests.
 *
 * CONTRATO CRÍTICO (idempotencia/resumibilidad): `projectSentMessage` es
 * best-effort e AISLADO. `SendCampaign` lo invoca DESPUÉS de persistir el `sent`
 * y captura cualquier excepción (loguea y sigue): un fallo de la proyección
 * JAMÁS debe re-marcar el recipient como `failed` (el envío ya salió → sería
 * re-envío). Idempotente por `recipient.id` (upsert por `campaignRecipientId`).
 */
export interface ProjectSentMessageInput {
  /** El recipient YA marcado `sent` (id = clave de idempotencia del mensaje bulk). */
  recipient: CampaignRecipient;
  /**
   * bulk-csv-recipients (D6, PRJ-1) — REEMPLAZA a `candidate: CampaignRecipientCandidate`
   * (ISP: el projector SOLO usaba `.name` del candidate, `PrismaCampaignInboxProjector.ts`
   * pre-D6). `SendCampaign` pasa `candidate.name` fresco (vinculado) o
   * `recipient.contactName` (crudo, CSV-3, sin `Client`).
   */
  contactName: string;
  /** Body renderizado del template (placeholders sustituidos) — contenido del ChatMessage. */
  renderedBody: string;
  /** ISO — mismo `sentAt` con que se persistió el recipient (ordena el hilo). */
  sentAt: string;
  /** SM… de Twilio (auditoría). */
  providerId: string | null;
}

/**
 * chatwoot-hub-sendpath (D9) — input de la proyección al inbox del path ON
 * (`SendCampaign` vía `chatwootGateway.createConversationWithTemplate`, CHW-2).
 * A diferencia de `ProjectSentMessageInput` (phone-keyed, crea `origin:'bulk'`
 * con `chatwootConversationId:null`), acá SIEMPRE hay un id REAL de Chatwoot
 * (find-or-create atómico YA resuelto por el gateway) — la Conversation se
 * upsertea por ESE id, no por teléfono.
 */
export interface ProjectChatwootTemplateSendInput {
  /** El recipient YA marcado `sent` — mismo criterio que `ProjectSentMessageInput.recipient`. */
  recipient: CampaignRecipient;
  contactName: string;
  contactPhone: string;
  /** id REAL de Chatwoot (find-or-create atómico, CHW-2) — clave de upsert de la Conversation. */
  chatwootConversationId: number;
  /** id REAL del primer mensaje de Chatwoot — clave de dedup con el eco del webhook (CHW-4/D5). */
  chatwootMessageId: number;
  /** Body renderizado del template (placeholders sustituidos) — contenido del ChatMessage. */
  renderedBody: string;
  /** ISO — mismo `sentAt` con que se persistió el recipient (ordena el hilo). */
  sentAt: string;
}

export interface CampaignInboxProjector {
  projectSentMessage(input: ProjectSentMessageInput): Promise<void>;
  /**
   * chatwoot-hub-sendpath (D9) — proyección al inbox para el path ON. Mismo
   * contrato best-effort/AISLADO que `projectSentMessage`: `SendCampaign` la
   * invoca DESPUÉS de persistir el `sent` y captura cualquier excepción — un
   * fallo de la proyección JAMÁS re-marca el recipient `failed`. Idempotente
   * por `chatwootConversationId`/`chatwootMessageId` (upserts), converge con
   * el eco del webhook sin duplicar.
   */
  projectChatwootTemplateSend(input: ProjectChatwootTemplateSendInput): Promise<void>;
}
