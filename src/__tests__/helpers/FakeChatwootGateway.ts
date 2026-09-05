import type {
  ChatwootGateway,
  ChatwootConversationDto,
  ChatwootLabelDto,
  ChatwootMessageDto,
  ChatwootMessageAttachmentDto,
  OutboundAttachmentFile,
} from '@domain/ports/ChatwootGateway';

/** Same catch-all mapping as `HttpChatwootGateway`/`SendMessage` — no real logic here,
 * just enough to fabricate a plausible `attachments[]` echo for the fake's default. */
function fakeFileType(contentType: string): string {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'file';
}

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

  /** Tanda 2 (SEND-4/BE1.10) — `files` records only the COUNT (not the buffers) sent,
   * keeping `toEqual` assertions from Tanda 1 stable (an `undefined` `files` is
   * ignored by `toEqual`, same as any other absent property).
   * messaging-inbox-notes (NOTE-4) — `private` records `options?.private` verbatim,
   * same "undefined is ignored by toEqual" property as `files`. */
  public sendMessageCalls: Array<{ chatwootConversationId: number; content: string; files?: number; private?: boolean }> = [];

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

  async sendMessage(
    chatwootConversationId: number,
    content: string,
    files?: OutboundAttachmentFile[],
    options?: { private?: boolean },
  ): Promise<ChatwootMessageDto> {
    this.sendMessageCalls.push({ chatwootConversationId, content, files: files?.length, private: options?.private });
    if (this.failSendMessage) throw new Error('fake: Chatwoot unreachable (sendMessage)');
    if (this.sendMessageResult) return this.sendMessageResult;

    // Tanda 2 (BE1.10) — default auto-generated echo, aligned by index with `files`,
    // so `SendMessage` tests that don't need a specific `sendMessageResult` still get
    // a plausible `attachments[]` back (id/sourceUrl/contentType per sent file).
    const attachments: ChatwootMessageAttachmentDto[] | undefined =
      files && files.length > 0
        ? files.map((f, i) => ({
            id: 90000 + i,
            fileType: fakeFileType(f.contentType),
            contentType: f.contentType,
            filename: f.filename,
            sizeBytes: f.buffer.length,
            width: null,
            height: null,
            sourceUrl: `https://fake-chatwoot.local/data/${90000 + i}`,
            thumbSourceUrl: null,
          }))
        : undefined;

    return {
      id: 999,
      direction: 'outbound',
      content,
      senderName: null,
      createdAt: new Date().toISOString(),
      attachments,
    };
  }

  /** F2 — not consumed by any F1 use case; kept trivial for contract completeness. */
  async searchContact(): Promise<{ id: number; name: string | null; phone: string | null }[]> {
    return [];
  }

  /** Invoked only by the one-shot ops script (B7), never by a use case. */
  async registerWebhook(): Promise<void> {}

  // ─── messaging-inbox-productivity (F1.5 fase C, STATUS-1) ───────────────────
  // conversation-snooze (Ola 6c) — `snoozedUntil` sólo se registra cuando el status es 'snoozed'
  // (undefined en resolve/reopen/pending); así los asserts existentes de `{chatwootConversationId,
  // status}` (toEqual estricto) siguen pasando sin una clave extra.
  public setStatusCalls: Array<{ chatwootConversationId: number; status: string; snoozedUntil?: string | null }> = [];
  public failSetStatus = false;

  async setStatus(
    chatwootConversationId: number,
    status: 'open' | 'resolved' | 'pending' | 'snoozed',
    snoozedUntil?: string | null,
  ): Promise<void> {
    this.setStatusCalls.push(
      status === 'snoozed'
        ? { chatwootConversationId, status, snoozedUntil: snoozedUntil ?? null }
        : { chatwootConversationId, status },
    );
    if (this.failSetStatus) throw new Error('fake: Chatwoot unreachable (setStatus)');
  }

  // ─── messaging-inbox-v2-media (Tanda 1 · MEDIA-2) ────────────────────────────
  /** Keyed by url. Populate before calling `downloadAttachment`. */
  public downloadsByUrl = new Map<string, { buffer: Buffer; contentType: string }>();
  public failDownloadAttachment = false;
  /**
   * fix-be #5 — selective failure by URL (the ORIGINAL boolean-only
   * `failDownloadAttachment` fails EVERYTHING, so it can't simulate "original OK,
   * thumbnail fails" — the exact degrade `DownloadChatMessageAttachment` is
   * supposed to handle gracefully). Populate before calling `downloadAttachment`.
   */
  public failUrls = new Set<string>();
  public downloadAttachmentCalls: Array<{ url: string; options?: { maxBytes?: number } }> = [];

  async downloadAttachment(
    url: string,
    options?: { maxBytes?: number },
  ): Promise<{ buffer: Buffer; contentType: string }> {
    this.downloadAttachmentCalls.push({ url, options });
    if (this.failDownloadAttachment || this.failUrls.has(url)) {
      throw new Error('fake: Chatwoot unreachable (downloadAttachment)');
    }
    const found = this.downloadsByUrl.get(url);
    if (found) return found;
    return { buffer: Buffer.from('fake-binary'), contentType: 'application/octet-stream' };
  }

  // ─── chatwoot-hub-sendpath (design D2.a, CHW-1) — sendTemplateMessage ───────
  /** Result returned by the NEXT `sendTemplateMessage()` call when `failSendTemplateMessage` is false. */
  public sendTemplateMessageResult: { chatwootMessageId: number; content: string } | null = null;
  public failSendTemplateMessage = false;
  public sendTemplateMessageCalls: Array<{
    chatwootConversationId: number;
    name: string;
    language: string;
    processedParams: Record<string, string>;
    content: string;
  }> = [];

  async sendTemplateMessage(
    chatwootConversationId: number,
    params: { name: string; language: string; processedParams: Record<string, string>; content: string },
  ): Promise<{ chatwootMessageId: number; content: string }> {
    this.sendTemplateMessageCalls.push({ chatwootConversationId, ...params });
    if (this.failSendTemplateMessage) throw new Error('fake: Chatwoot unreachable (sendTemplateMessage)');
    if (this.sendTemplateMessageResult) return this.sendTemplateMessageResult;
    return { chatwootMessageId: 999, content: params.content };
  }

  // ─── chatwoot-hub-sendpath (design D2.b, CHW-2) — createConversationWithTemplate ──
  /** Result returned by the NEXT `createConversationWithTemplate()` call when `failCreateConversationWithTemplate` is false.
   * F6 (fix wave) — `chatwootMessageId` es `number | null`: configurable a null para probar el
   * seam donde el gateway no pudo extraer el id (Prisma rechaza NaN → antes rompía la proyección). */
  public createConversationWithTemplateResult: {
    chatwootConversationId: number;
    chatwootMessageId: number | null;
  } | null = null;
  public failCreateConversationWithTemplate = false;
  public createConversationWithTemplateCalls: Array<{
    phoneE164: string;
    name?: string | null;
    templateName: string;
    language: string;
    processedParams: Record<string, string>;
    content: string;
  }> = [];

  async createConversationWithTemplate(params: {
    phoneE164: string;
    name?: string | null;
    templateName: string;
    language: string;
    processedParams: Record<string, string>;
    content: string;
  }): Promise<{ chatwootConversationId: number; chatwootMessageId: number | null }> {
    this.createConversationWithTemplateCalls.push({ ...params });
    if (this.failCreateConversationWithTemplate) {
      throw new Error('fake: Chatwoot unreachable (createConversationWithTemplate)');
    }
    if (this.createConversationWithTemplateResult) return this.createConversationWithTemplateResult;
    return { chatwootConversationId: 888, chatwootMessageId: 999 };
  }

  // ─── campaign-chatwoot-label (design D1/D2, CLBL-1) — listAccountLabels ────
  /** Poblar antes de llamar `listAccountLabels()`. */
  public accountLabelsResult: ChatwootLabelDto[] = [];
  /**
   * external-bulk-messaging (VAL-5) — simula Chatwoot inalcanzable al listar
   * labels. El use case (`ValidateExternalBulk`) envuelve CUALQUIER falla del
   * gateway en `ChatwootUnavailableError` (mismo criterio que el resto del
   * port) — este fake solo necesita lanzar ALGO, no el tipo exacto.
   */
  public failListAccountLabels = false;

  async listAccountLabels(): Promise<ChatwootLabelDto[]> {
    if (this.failListAccountLabels) throw new Error('fake: Chatwoot unreachable (listAccountLabels)');
    return this.accountLabelsResult;
  }

  // ─── campaign-chatwoot-label (design D1/D2, CLBL-2) — createAccountLabel ───
  /** Resultado devuelto por la PRÓXIMA `createAccountLabel()` cuando `failCreateAccountLabel` es false. */
  public createAccountLabelResult: ChatwootLabelDto | null = null;
  public failCreateAccountLabel = false;
  public createAccountLabelCalls: Array<{ title: string; color: string }> = [];

  async createAccountLabel(params: { title: string; color: string }): Promise<ChatwootLabelDto> {
    this.createAccountLabelCalls.push({ ...params });
    if (this.failCreateAccountLabel) throw new Error('fake: Chatwoot unreachable (createAccountLabel)');
    const created = this.createAccountLabelResult ?? { title: params.title, color: params.color };
    // fix wave F1 (external-labels-required, finding 2) — el REAL Chatwoot
    // persiste el label creado: una llamada subsiguiente a `listAccountLabels()`
    // lo devuelve. El fake antes NO mutaba `accountLabelsResult`, así que un
    // caller que creaba un label y en la MISMA suite lo validaba contra el
    // catálogo (round-trip create→validate) veía un catálogo desactualizado —
    // no era un bug del código bajo test, era el fake mintiendo. Se agrega acá
    // (append, sin duplicar por título) para que el fake se comporte como el
    // adapter real que envuelve.
    if (!this.accountLabelsResult.some((l) => l.title === created.title)) {
      this.accountLabelsResult.push(created);
    }
    return created;
  }

  // ─── campaign-chatwoot-label (design D1.c/D2, CLBL-3/4/5) — addConversationLabels ──
  /**
   * El fake **NO** hace la unión (D2 — esa mecánica GET-unión-POST vive DENTRO
   * del adapter real): solo registra el DELTA que se le pidió agregar, tal cual.
   * La preservación de pre-existentes/idempotencia se prueba a nivel ADAPTER
   * (`HttpChatwootGateway.test.ts`), no acá — el seam de `SendCampaign` solo
   * verifica que se pidió agregar el label correcto.
   */
  public addConversationLabelsCalls: Array<{ chatwootConversationId: number; labels: string[] }> = [];
  public failAddConversationLabels = false;

  async addConversationLabels(chatwootConversationId: number, labels: string[]): Promise<void> {
    this.addConversationLabelsCalls.push({ chatwootConversationId, labels: [...labels] });
    if (this.failAddConversationLabels) throw new Error('fake: Chatwoot unreachable (addConversationLabels)');
  }

  // ─── ai-assistant-cobranzas (D10/ACT-4) — unassignConversation ────────────────
  public unassignConversationCalls: number[] = [];
  public failUnassignConversation = false;

  async unassignConversation(chatwootConversationId: number): Promise<void> {
    this.unassignConversationCalls.push(chatwootConversationId);
    if (this.failUnassignConversation) throw new Error('fake: Chatwoot unreachable (unassignConversation)');
  }
}
