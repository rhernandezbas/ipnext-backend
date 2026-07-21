import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatMessageRepository, ChatMessageRecord } from '@domain/ports/ChatMessageRepository';
import type { TemplateMessagingPort } from '@domain/ports/TemplateMessagingPort';
import type { ChatwootGateway } from '@domain/ports/ChatwootGateway';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import {
  ConversationNotFoundError,
  ConversationPhoneMissingError,
  ConversationNotLinkedError,
  ChatwootUnavailableError,
} from '@domain/errors/messaging';
import { TemplateNotApprovedError, MissingTemplateVariablesError } from '@domain/errors/messaging-bulk';
import { toWhatsAppE164 } from './toWhatsAppE164';
import { renderTemplateBody } from './SendCampaign';
import { toChatMessageDto, type ChatMessageDto } from '@application/dto/messaging';

/**
 * inbox-template-send (TS-1..TS-6, design D9) — envía UN template WhatsApp
 * aprobado desde el hilo YA abierto por el agente, vía Twilio Content directo
 * (D1 — `TemplateMessagingPort`, el MISMO port/adapter/fake que el bulk, send-path
 * LOCKED). Reemplaza el aviso estático de ventana expirada (`Composer.tsx:240-244`):
 * un template es enviable SIEMPRE (dentro o fuera de la ventana de 24h) y NUNCA
 * la abre (D2, regla de plataforma verificada por el usuario) — este use case
 * jamás toca `canReply`/`status` de la conversación.
 *
 * Proyección propia (D3) — NUNCA reusa `upsertBulkMessage`/`CampaignInboxProjector`:
 * acá SIEMPRE hay una `conversationId` concreta (la que el agente tiene abierta),
 * a diferencia del bulk que resuelve por teléfono (podría aterrizar en otra
 * conversación con duplicados del mismo E164). Idempotencia por `providerMessageId`
 * (SM sid de Twilio, D5).
 *
 * chatwoot-hub-sendpath (D1/D3) — FLAG-AWARE: `messaging-send-via-chatwoot`
 * (`FeatureFlagRepository.get`, resuelto POR INVOCACIÓN, nunca cacheado) rebautiza
 * el guard 2 y los pasos 5/6. OFF (default, o `chatwootGateway`/`featureFlags`
 * AUSENTES — backcompat, molde `SendCampaign`): comportamiento BYTE-IDÉNTICO al
 * de siempre (CHW-3). ON: guard 2 exige `conversation.chatwootConversationId`
 * (en vez de teléfono) y el envío/persistencia van por `ChatwootGateway`/
 * `upsertByChatwootMessageId` (CHW-1/CHW-4/D5) — el MISMO método que el eco del
 * webhook, así que ambos caminos convergen en una sola fila. El gate de
 * aprobación (guard 3) y el orden guard1→guard2→guard3→guard4 quedan INTACTOS en
 * AMBOS paths (H4, orden PINNED D9 de inbox-template-send) — el flag sólo cambia
 * QUÉ hace el guard 2 y el paso 5/6, nunca su POSICIÓN relativa.
 *
 * Guard order PINNED (D9), cortando en la primera falla, SIN side effects (ni
 * persistencia ni `sendTemplate`) hasta el paso 5:
 *   0. (fix wave, H1 — idempotency-key server-side) `idempotencyKey` presente →
 *      `messageRepo.findByIdempotencyKey`. HIT → devuelve ESE mensaje
 *      (`deduped:true`), CERO llamadas a `conversationRepo`/`templatePort`/
 *      persistencia — es un retry semántico del MISMO request ya completado, no
 *      un request nuevo a re-validar. Corre ANTES que TODO lo demás a propósito:
 *      protege un timeout de red tras el accept de Twilio + reintento del
 *      operador de generar un SEGUNDO WhatsApp real (doble costo). Ausente/no
 *      match → sigue el flujo normal desde el paso 1 (comportamiento actual,
 *      FE viejo que no manda la key).
 *   1. `conversationRepo.findById` → 404 `ConversationNotFoundError`.
 *   2. Teléfono: `contactPhoneE164` con fallback `toWhatsAppE164(contactPhone)`
 *      (cubre filas pre-backfill) → 422 `ConversationPhoneMissingError` si ambos null.
 *   3. `templatePort.listTemplates()` → template `approved` (criterio CAMP-2,
 *      inexistente en el proveedor se trata igual que no-aprobado) → 422
 *      `TemplateNotApprovedError`.
 *   4. TODAS las variables declaradas presentes como keys (criterio CAMP-3;
 *      extra no bloquean) → 422 `MissingTemplateVariablesError(missing)`.
 *   5. `templatePort.sendTemplate` — SIN `sendWithRetry` (D6, interactivo, NO
 *      batch worker). Errores tipados (`TemplateSendRejectedError`/
 *      `TemplateProviderUnavailableError`/`TemplateProviderConfigError`) propagan
 *      tal cual — cero persistencia en falla.
 *   6. Post-OK: `renderTemplateBody` (reuso de `SendCampaign.ts`, pura/total) +
 *      `upsertTemplateMessage` (`providerMessageId = result.providerId`,
 *      `idempotencyKey` pass-through — el `@unique` de esa columna es el
 *      backstop de carrera: dos requests concurrentes con la MISMA key que
 *      AMBOS pasaron el guard 0 chocan ahí, y el repo recupera la fila
 *      ganadora en vez de duplicar/500 — ver `PrismaChatMessageRepository`/
 *      `InMemoryChatMessageRepository`).
 *   7. `bumpLastMessage` — SOLO preview, jamás `canReply`/`status` (D2/D5).
 *   8. `{message: toChatMessageDto(record, []), deduped: false}` — nunca la
 *      fila cruda. `deduped` distingue "devolví un mensaje YA enviado antes"
 *      (guard 0) de "acabo de enviarlo ahora" — el route mapea esto a 200 vs
 *      201 respectivamente.
 */
export interface SendTemplateMessageResult {
  message: ChatMessageDto;
  /** H1 — true SOLO si el guard 0 (fast path) resolvió sin invocar sendTemplate. */
  deduped: boolean;
}

export class SendTemplateMessage {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly templatePort: TemplateMessagingPort,
    private readonly messageRepo: ChatMessageRepository,
    /**
     * chatwoot-hub-sendpath (D1/D3) — OPCIONALES (backcompat, mismo molde que el
     * `inboxProjector` opcional de `SendCampaign`): AUSENTES → el flag SIEMPRE
     * resuelve a OFF (`featureFlags?.get(...)` es `undefined`), comportamiento
     * actual intacto sin tocar `app.ts` (wiring real en B6). Cuando `app.ts` los
     * cablea, SIEMPRE van juntos (el flag sin gateway sería un wiring roto).
     */
    private readonly chatwootGateway?: ChatwootGateway,
    private readonly featureFlags?: FeatureFlagRepository,
  ) {}

  async execute(
    conversationId: string,
    templateRef: string,
    variables: Record<string, string>,
    /** `req.user?.username` — NUNCA del body (D9). `null` cuando no hay agente identificable (ej. tests). */
    senderName?: string | null,
    /**
     * H1 (fix wave) — key de idempotencia del request HTTP (UUID del FE,
     * body `idempotencyKey`). `undefined`/`null` → sin dedup, comportamiento
     * actual (FE viejo que no la manda).
     */
    idempotencyKey?: string | null,
  ): Promise<SendTemplateMessageResult> {
    // H1 — guard 0, fast path. Corre ANTES de CUALQUIER otro guard/side-effect.
    if (idempotencyKey) {
      const existing = await this.messageRepo.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return { message: toChatMessageDto(existing, []), deduped: true };
      }
    }

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    // chatwoot-hub-sendpath (D1/D3) — resuelto POR INVOCACIÓN, nunca cacheado.
    // `featureFlags` AUSENTE (backcompat, wiring de B6 pendiente) → SIEMPRE OFF.
    // F5 (fix wave) — la lectura NO debe agregar superficie de fallo nueva al hot path: si el
    // repo de flags EXPLOTA (hipo de DB), se loguea y se defaultea a OFF (path Twilio-directo de
    // siempre) en vez de volar el envío. El flag es un kill-switch, no una dependencia crítica.
    const viaChat = await this.resolveViaChat();

    // guard 2 — PINNED en su posición original (H4/D9 de inbox-template-send: debe
    // correr ANTES del gate de aprobación/template, en AMBOS flags). El flag sólo
    // cambia QUÉ valida: teléfono (OFF) vs link a Chatwoot (ON, CHW-1).
    let phoneE164: string | null = null;
    if (!viaChat) {
      phoneE164 = conversation.contactPhoneE164 ?? toWhatsAppE164(conversation.contactPhone);
      if (!phoneE164) throw new ConversationPhoneMissingError(conversationId);
    } else if (conversation.chatwootConversationId == null) {
      throw new ConversationNotLinkedError(conversationId);
    }

    // TS-3 / CAMP-2 — templateRef inexistente se trata IGUAL que no-aprobado.
    // CHW-6 — este gate es NUESTRO (Twilio Content API directo), INTACTO sin importar el flag.
    const templates = await this.templatePort.listTemplates();
    const template = templates.find((t) => t.contentSid === templateRef);
    if (!template || template.approvalStatus !== 'approved') {
      throw new TemplateNotApprovedError(templateRef);
    }

    // TS-4 / CAMP-3 — variables extra no declaradas NO bloquean.
    const declaredVariableNames = Object.keys(template.variables);
    const missing = declaredVariableNames.filter((name) => !(name in variables));
    if (missing.length > 0) {
      throw new MissingTemplateVariablesError(missing);
    }

    let record: ChatMessageRecord;
    let sentAt: string;
    let renderedBody: string;

    if (!viaChat) {
      // TS-5 — SIN sendWithRetry (D6). Nada persistido hasta acá.
      const result = await this.templatePort.sendTemplate(phoneE164!, templateRef, variables);

      // TS-6 — post-OK: proyección al hilo + bump del preview.
      sentAt = new Date().toISOString();
      renderedBody = renderTemplateBody(template.body, variables);

      record = await this.messageRepo.upsertTemplateMessage({
        conversationId: conversation.id,
        providerMessageId: result.providerId,
        content: renderedBody,
        senderName: senderName ?? null,
        chatwootCreatedAt: sentAt,
        idempotencyKey: idempotencyKey ?? null,
      });
    } else {
      // D3/CHW-1 — `content` se necesita ANTES del POST a Chatwoot; `renderTemplateBody`
      // es pura/total (sin side effects) — reordenarla antes del send es inocuo (design D3).
      renderedBody = renderTemplateBody(template.body, variables);

      let sendResult: { chatwootMessageId: number; content: string };
      try {
        sendResult = await this.chatwootGateway!.sendTemplateMessage(conversation.chatwootConversationId!, {
          name: template.friendlyName,
          language: template.language,
          processedParams: variables,
          content: renderedBody,
        });
      } catch {
        // CHW-7 — cualquier falla del gateway (red/timeout/4xx/5xx) → ChatwootUnavailableError,
        // CERO persistencia (mismo criterio de mapeo que SendMessage.ts).
        throw new ChatwootUnavailableError();
      }

      sentAt = new Date().toISOString();

      // CHW-4/D5 — MISMO método que el eco del webhook (`message_created`): converge
      // por `chatwootMessageId`, jamás duplica. `idempotencyKey` SET-ONCE (guard 0 ON).
      record = await this.messageRepo.upsertByChatwootMessageId({
        conversationId: conversation.id,
        chatwootMessageId: sendResult.chatwootMessageId,
        direction: 'outbound',
        content: renderedBody,
        senderName: senderName ?? null,
        chatwootCreatedAt: sentAt,
        idempotencyKey: idempotencyKey ?? null,
      });
    }

    // D2 (inbox-template-send) — SOLO preview; jamás canReply/status, sin importar el flag.
    await this.conversationRepo.bumpLastMessage(conversation.id, {
      lastMessageAt: sentAt,
      lastMessagePreview: renderedBody,
    });

    return { message: toChatMessageDto(record, []), deduped: false };
  }

  /**
   * chatwoot-hub-sendpath (F5, fix wave) — lee el flag `messaging-send-via-chatwoot` de forma
   * FAIL-SAFE: cualquier error del repo se loguea y resuelve a OFF (path Twilio-directo). Sin
   * este wrap, un hipo de DB al leer el flag volaba el envío entero (regresión de robustez).
   */
  private async resolveViaChat(): Promise<boolean> {
    try {
      return (await this.featureFlags?.get('messaging-send-via-chatwoot'))?.enabled === true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[messaging] lectura del flag messaging-send-via-chatwoot falló (fail-safe OFF, envío por el path de siempre)', {
        error: err instanceof Error ? err.message : err,
      });
      return false;
    }
  }
}
